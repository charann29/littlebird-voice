/**
 * THE single queue dispatcher for the app (section 30 owns this file).
 *
 * Consumes canonical `IngestMessage`s from `littlebird-ingest` and routes per
 * message:
 *  - `kind: "document"` and any message whose `jobs` include "index" (or omit
 *    `jobs`) → `ingestMemory` (chunk + embed + index).
 *  - `kind: "transcript"` messages whose `jobs` include "summarize" (or omit
 *    `jobs` — omitted means "all applicable jobs" per IngestMessage's
 *    contract, and both index AND summarize apply to transcripts) → section
 *    20's `handleTranscriptAutoSummary(env, msg)`.
 *
 * Failures THROW (message.retry()) so the queue redelivers; after
 * `max_retries: 3` (wrangler.jsonc) the message dead-letters to
 * `littlebird-ingest-dlq`. Successful messages are acked individually so one
 * bad message in a batch doesn't retry its siblings.
 */

import type { Env } from "../env";
import type { IngestJob, IngestMessage } from "../services/ingest-message";
import { ingestMemory, type IngestDeps } from "../memory/ingest";
import { handleTranscriptAutoSummary } from "../ai/summarize";

/** Signature of section 20's auto-summary handler. */
export type TranscriptAutoSummaryHandler = (
  env: Env,
  msg: IngestMessage,
) => Promise<unknown>;

/** Test seam: overrides used instead of the real deps when set. */
export interface DispatcherDeps extends IngestDeps {
  handleTranscriptAutoSummary?: TranscriptAutoSummaryHandler;
}

function isIngestMessage(body: unknown): body is IngestMessage {
  if (body === null || typeof body !== "object") return false;
  const m = body as Partial<IngestMessage>;
  return (
    typeof m.userId === "string" &&
    typeof m.parentId === "string" &&
    typeof m.sourceRevision === "number" &&
    (m.kind === "transcript" || m.kind === "summary" || m.kind === "document")
  );
}

/**
 * Process one IngestMessage: run every applicable job; throw on any failure
 * so the queue retries the whole message (jobs are idempotent — the index job
 * hash-skips unchanged chunks and section 20's auto-summary is
 * revision-idempotent — so partial re-runs are safe).
 */
export async function dispatchIngestMessage(
  env: Env,
  msg: IngestMessage,
  deps: DispatcherDeps = {},
): Promise<void> {
  // Omitted `jobs` means "all applicable" (IngestMessage contract): both
  // index and summarize apply to transcripts; only index applies to
  // summary/document kinds. Explicit `jobs` are honored as-is.
  const jobs: IngestJob[] =
    msg.jobs ?? (msg.kind === "transcript" ? ["index", "summarize"] : ["index"]);

  // Index job: kind "document" always indexes; others when jobs include it.
  if (msg.kind === "document" || jobs.includes("index")) {
    await ingestMemory(env, msg, deps);
  }

  // Summarize job: transcript messages only (section 20's handler).
  if (msg.kind === "transcript" && jobs.includes("summarize")) {
    const handler = deps.handleTranscriptAutoSummary ?? handleTranscriptAutoSummary;
    try {
      await handler(env, msg);
    } catch (err) {
      // Per section 20's contract: terminal ai_bad_output (model returned
      // unrepairable JSON) is logged + DROPPED — retrying cannot fix it and
      // the user can still summarize manually. Duck-typed check so we don't
      // hard-depend on section 20's AiError class.
      if ((err as { code?: string })?.code === "ai_bad_output") {
        console.error(
          `[queue] summarize for session ${msg.parentId} dropped (ai_bad_output):`,
          err,
        );
      } else {
        throw err; // transient — let the queue retry
      }
    }
  }
}

/** The app's one `queue()` handler (registered from src/index.ts). */
export async function queueHandler(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    if (!isIngestMessage(message.body)) {
      console.error(
        `[queue] dropping malformed message: ${JSON.stringify(message.body)}`,
      );
      message.ack(); // malformed forever — retrying cannot help
      continue;
    }
    try {
      await dispatchIngestMessage(env, message.body);
      message.ack();
    } catch (err) {
      console.error(
        `[queue] ${message.body.kind}:${message.body.parentId} failed (attempt ${message.attempts}):`,
        err,
      );
      message.retry(); // → DLQ after max_retries (3)
    }
  }
}
