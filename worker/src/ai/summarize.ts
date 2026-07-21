/**
 * Summary generation core (section 20 T1).
 *
 * - `generateSummary(env, userId, sessionId, opts?)` — verify status 'done',
 *   load transcript_segments, render, single-call or map-reduce summarize,
 *   validate, persist via section 10's `saveSummary` (NEVER a direct
 *   `summaries` write — its post-save hook enqueues the summary for memory
 *   indexing).
 * - `handleTranscriptAutoSummary(env, msg)` — the pure queue handler section
 *   30's dispatcher (worker/src/queue/consumer.ts) invokes for
 *   `kind:"transcript"` messages whose `jobs` include `"summarize"`. This
 *   file does NOT create/register the consumer.
 *
 * Idempotency (at-least-once queue delivery):
 * - stored payload records `source_revision` (= msg.sourceRevision) and
 *   `request_id` (forced regenerations only);
 * - redelivered message with matching source_revision → no-op;
 * - stale message (sourceRevision ≠ session's current transcript_revision)
 *   → dropped;
 * - `forceSummary` bypasses the revision short-circuit, but a duplicate
 *   forced `requestId` is still a no-op.
 */

import type { Env } from "../env";
import type { IngestMessage } from "../services/ingest-message";
import { saveSummary } from "../services/persistence";
import {
  chunkSegments,
  estimateTokens,
  MAX_INPUT_TOKENS,
  renderTranscript,
} from "./chunking";
import {
  SUMMARIZE_SYSTEM,
  SUMMARY_SCHEMA,
  summarizeReducePrompt,
  summarizeUserPrompt,
} from "./prompts";
import { completeJson, getProvider, type LlmProvider } from "./provider";
import { isSummaryV1, validateSummaryContent, type SummaryContent, type SummaryV1 } from "./types";

/** Kind used for all meeting summaries in the `summaries` table. */
export const MEETING_SUMMARY_KIND = "meeting_summary";

/** One transcript_segments row (subset used for prompt rendering). */
export interface SegmentRow {
  speaker: string | null;
  start_ms: number | null;
  end_ms: number | null;
  text: string;
}

/** 409 transcript_not_ready — session not 'done' or no segments. */
export class TranscriptNotReadyError extends Error {
  readonly code = "transcript_not_ready";
  constructor(message: string) {
    super(message);
    this.name = "TranscriptNotReadyError";
  }
}

/** Session not found / not owned — routes map to 404. */
export class SessionNotFoundError extends Error {
  readonly code = "not_found";
  constructor(sessionId: string) {
    super(`Session ${sessionId} not found`);
    this.name = "SessionNotFoundError";
  }
}

interface SessionAiRow {
  id: string;
  title: string;
  status: string;
  duration_ms: number;
  self_speaker: string | null;
  transcript_revision: number;
}

/** Load a user-owned session row (fields the AI features need). */
export async function loadOwnedSession(
  env: Env,
  userId: string,
  sessionId: string,
): Promise<SessionAiRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, title, status, duration_ms, self_speaker, transcript_revision
     FROM sessions WHERE id = ? AND user_id = ?`,
  )
    .bind(sessionId, userId)
    .first<SessionAiRow>();
  return row ?? null;
}

/** Load transcript segments in order. */
export async function loadSegments(
  env: Env,
  sessionId: string,
): Promise<SegmentRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT speaker, start_ms, end_ms, text
     FROM transcript_segments WHERE session_id = ? ORDER BY seq`,
  )
    .bind(sessionId)
    .all<SegmentRow>();
  return results;
}

/** Read the stored meeting_summary payload (validated), or null. */
export async function loadStoredSummary(
  env: Env,
  sessionId: string,
): Promise<{ payload: SummaryV1; generated_at: number } | null> {
  const row = await env.DB.prepare(
    `SELECT payload_json, created_at FROM summaries
     WHERE session_id = ? AND kind = ?`,
  )
    .bind(sessionId, MEETING_SUMMARY_KIND)
    .first<{ payload_json: string; created_at: number }>();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.payload_json) as unknown;
    if (isSummaryV1(parsed)) {
      return { payload: parsed, generated_at: row.created_at };
    }
  } catch {
    /* corrupt payload — treat as missing */
  }
  return null;
}

async function summarizeSingle(
  provider: LlmProvider,
  title: string,
  durationMs: number,
  transcript: string,
): Promise<SummaryContent> {
  return completeJson(
    provider,
    {
      system: SUMMARIZE_SYSTEM,
      user: summarizeUserPrompt(title, durationMs, transcript),
      json: SUMMARY_SCHEMA,
    },
    validateSummaryContent,
  );
}

/** Map-reduce for transcripts over budget: partial summaries then one merge. */
async function summarizeMapReduce(
  provider: LlmProvider,
  title: string,
  durationMs: number,
  segments: SegmentRow[],
): Promise<SummaryContent> {
  const chunks = chunkSegments(segments);
  const partials: SummaryContent[] = [];
  for (const chunk of chunks) {
    partials.push(
      await summarizeSingle(provider, title, durationMs, renderTranscript(chunk)),
    );
  }
  return completeJson(
    provider,
    {
      system: SUMMARIZE_SYSTEM,
      user: summarizeReducePrompt(partials.map((p) => JSON.stringify(p))),
      json: SUMMARY_SCHEMA,
    },
    validateSummaryContent,
  );
}

export interface GenerateSummaryOptions {
  /**
   * transcript_revision the caller is generating FROM (queue path). Defaults
   * to the session's current transcript_revision (manual path).
   */
  sourceRevision?: number;
  /** Idempotency key recorded in the payload for forced regenerations. */
  requestId?: string;
}

/**
 * Generate + persist the meeting summary. Throws:
 * - SessionNotFoundError → 404
 * - TranscriptNotReadyError → 409 transcript_not_ready
 * - AiError → 502 ai_bad_output / 503 ai_unavailable
 */
export async function generateSummary(
  env: Env,
  userId: string,
  sessionId: string,
  opts: GenerateSummaryOptions = {},
): Promise<SummaryV1> {
  const session = await loadOwnedSession(env, userId, sessionId);
  if (!session) throw new SessionNotFoundError(sessionId);
  if (session.status !== "done") {
    throw new TranscriptNotReadyError(
      `Session status is '${session.status}', not 'done'`,
    );
  }
  const segments = await loadSegments(env, sessionId);
  if (segments.length === 0) {
    throw new TranscriptNotReadyError("Session has no transcript segments");
  }

  const provider = getProvider(env);
  const transcript = renderTranscript(segments);
  const content =
    estimateTokens(transcript) <= MAX_INPUT_TOKENS
      ? await summarizeSingle(provider, session.title, session.duration_ms, transcript)
      : await summarizeMapReduce(provider, session.title, session.duration_ms, segments);

  const payload: SummaryV1 = {
    version: 1,
    model: provider.model,
    source_revision: opts.sourceRevision ?? session.transcript_revision,
    request_id: opts.requestId ?? null,
    ...content,
  };

  // Canonical write path — saveSummary upserts per (session_id, kind) and
  // its post-save hook enqueues the summary for memory ingestion.
  await saveSummary(env, userId, sessionId, MEETING_SUMMARY_KIND, payload, provider.model);
  return payload;
}

/** Shape of forced-regeneration messages (manual regenerate → queue). */
export interface SummarizeQueueMessage extends IngestMessage {
  forceSummary?: boolean;
}

/**
 * Pure queue handler for `kind:"transcript"` messages with jobs including
 * `"summarize"` — invoked by section 30's dispatcher
 * (worker/src/queue/consumer.ts). Idempotent under at-least-once delivery:
 *
 * 1. duplicate forced requestId → no-op;
 * 2. non-forced redelivery whose sourceRevision already matches the stored
 *    summary's source_revision → no-op;
 * 3. stale message (sourceRevision ≠ session's current transcript_revision)
 *    → dropped;
 * 4. otherwise generate. Throwing lets the queue retry (max_retries from
 *    wrangler.jsonc); terminal ai_bad_output should be logged + dropped by
 *    the dispatcher (the user can still summarize manually).
 */
export async function handleTranscriptAutoSummary(
  env: Env,
  msg: SummarizeQueueMessage,
): Promise<"generated" | "skipped"> {
  if (msg.kind !== "transcript") return "skipped";

  const session = await loadOwnedSession(env, msg.userId, msg.parentId);
  if (!session) return "skipped"; // session deleted since enqueue

  const stored = await loadStoredSummary(env, msg.parentId);
  const force = msg.forceSummary === true;

  if (force) {
    // Duplicate forced regeneration (redelivered message) → no-op.
    if (msg.requestId && stored?.payload.request_id === msg.requestId) {
      return "skipped";
    }
  } else {
    // Redelivery: already summarized this exact transcript revision → no-op.
    if (stored?.payload.source_revision === msg.sourceRevision) {
      return "skipped";
    }
    // Stale: the transcript moved on; a newer message is (or will be) queued.
    if (msg.sourceRevision !== session.transcript_revision) {
      return "skipped";
    }
  }

  try {
    await generateSummary(env, msg.userId, msg.parentId, {
      sourceRevision: msg.sourceRevision,
      ...(force && msg.requestId ? { requestId: msg.requestId } : {}),
    });
    return "generated";
  } catch (err) {
    if (err instanceof TranscriptNotReadyError) {
      // Session no longer 'done' (re-transcribing etc.) — drop, a later
      // message will follow the next transcript save.
      return "skipped";
    }
    throw err; // let the queue retry transient failures
  }
}
