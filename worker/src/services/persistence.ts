/**
 * Canonical write path for transcripts and summaries.
 *
 * ALL transcript/summary writes — this section's REST routes and section 20's
 * generateSummary — MUST go through `saveTranscript` / `saveSummary`; never
 * write these tables from route handlers directly. Each function:
 *  1. validates session ownership (sessions.user_id = userId),
 *  2. writes D1 AND atomically increments the revision counter in the same
 *     `db.batch()` (sessions.transcript_revision for transcripts;
 *     summaries.revision for summaries),
 *  3. fires a single post-save hook publishing an IngestMessage to
 *     INGEST_QUEUE with `sourceRevision` = that new revision.
 *
 * Section 30 hooks memory ingestion by consuming the queue, not by patching
 * call sites.
 */

import type { Env } from "../env";
import type { IngestJob, IngestMessage } from "./ingest-message";

/** Input shape for one transcript segment (seq assigned by array order). */
export interface SegmentInput {
  speaker?: string | null;
  start_ms?: number | null;
  end_ms?: number | null;
  text: string;
}

/** Summary row as returned by saveSummary / the summaries endpoints. */
export interface Summary {
  id: string;
  session_id: string;
  kind: string;
  payload: object;
  model: string | null;
  revision: number;
  created_at: number;
}

/** Optional per-call queue-message extras (used by section 20's flows). */
export interface PersistOptions {
  jobs?: IngestJob[];
  requestId?: string;
}

/** Thrown by the persistence services; routes map `code` to HTTP status. */
export class PersistenceError extends Error {
  constructor(
    public code: "not_found" | "bad_request",
    message: string,
  ) {
    super(message);
    this.name = "PersistenceError";
  }
}

/** Ownership check: session must exist AND belong to userId. */
async function assertOwnedSession(
  env: Env,
  userId: string,
  sessionId: string,
): Promise<void> {
  const row = await env.DB.prepare("SELECT user_id FROM sessions WHERE id = ?")
    .bind(sessionId)
    .first<{ user_id: string }>();
  if (!row || row.user_id !== userId) {
    throw new PersistenceError("not_found", `Session ${sessionId} not found`);
  }
}

/** Single post-save hook — the ONLY place ingest messages are enqueued. */
async function publishIngest(env: Env, message: IngestMessage): Promise<void> {
  await env.INGEST_QUEUE.send(message);
}

/**
 * Replace ALL transcript segments for a session in one atomic D1 batch
 * (delete + inserts + revision bump) — the simplest idempotent shape for
 * re-transcription. Returns the segment count and the NEW transcript_revision.
 */
export async function saveTranscript(
  env: Env,
  userId: string,
  sessionId: string,
  segments: SegmentInput[],
  opts?: PersistOptions,
): Promise<{ count: number; revision: number }> {
  await assertOwnedSession(env, userId, sessionId);

  const statements: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM transcript_segments WHERE session_id = ?").bind(
      sessionId,
    ),
    ...segments.map((seg, seq) =>
      env.DB.prepare(
        `INSERT INTO transcript_segments (session_id, seq, speaker, start_ms, end_ms, text)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        sessionId,
        seq,
        seg.speaker ?? null,
        seg.start_ms ?? null,
        seg.end_ms ?? null,
        seg.text,
      ),
    ),
    env.DB.prepare(
      `UPDATE sessions SET transcript_revision = transcript_revision + 1, updated_at = ?
       WHERE id = ? RETURNING transcript_revision`,
    ).bind(Date.now(), sessionId),
  ];

  const results = await env.DB.batch(statements);
  const last = results[results.length - 1];
  const revision = (last.results?.[0] as { transcript_revision: number })
    .transcript_revision;

  await publishIngest(env, {
    userId,
    kind: "transcript",
    parentId: sessionId,
    sourceRevision: revision,
    ...(opts?.jobs ? { jobs: opts.jobs } : {}),
    ...(opts?.requestId ? { requestId: opts.requestId } : {}),
  });

  return { count: segments.length, revision };
}

/**
 * Upsert a summary per (session_id, kind), bumping `summaries.revision`
 * atomically in the same statement, then publish an IngestMessage carrying
 * the new revision.
 */
export async function saveSummary(
  env: Env,
  userId: string,
  sessionId: string,
  kind: string,
  payload: object,
  model?: string,
  opts?: PersistOptions,
): Promise<Summary> {
  await assertOwnedSession(env, userId, sessionId);

  const row = await env.DB.prepare(
    `INSERT INTO summaries (id, session_id, kind, payload_json, model, revision, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT (session_id, kind) DO UPDATE SET
       payload_json = excluded.payload_json,
       model = excluded.model,
       revision = summaries.revision + 1,
       created_at = excluded.created_at
     RETURNING id, session_id, kind, payload_json, model, revision, created_at`,
  )
    .bind(
      crypto.randomUUID(),
      sessionId,
      kind,
      JSON.stringify(payload),
      model ?? null,
      Date.now(),
    )
    .first<{
      id: string;
      session_id: string;
      kind: string;
      payload_json: string;
      model: string | null;
      revision: number;
      created_at: number;
    }>();

  if (!row) {
    throw new PersistenceError("bad_request", "Summary upsert returned no row");
  }

  const summary: Summary = {
    id: row.id,
    session_id: row.session_id,
    kind: row.kind,
    payload: JSON.parse(row.payload_json) as object,
    model: row.model,
    revision: row.revision,
    created_at: row.created_at,
  };

  await publishIngest(env, {
    userId,
    kind: "summary",
    parentId: sessionId,
    sourceRevision: summary.revision,
    ...(opts?.jobs ? { jobs: opts.jobs } : {}),
    ...(opts?.requestId ? { requestId: opts.requestId } : {}),
  });

  return summary;
}
