/**
 * Canonical message published to INGEST_QUEUE by the persistence services
 * (the SINGLE place memory ingestion is enqueued). Consumed by the queue
 * dispatcher `worker/src/queue/consumer.ts` (owned by section 30).
 *
 * Identity convention (fixed — section 30's vector IDs depend on it):
 * - `parentId` is `sessions.id` for BOTH `kind: "transcript"` and
 *   `kind: "summary"` (the `kind` field, plus `summaries.kind` looked up
 *   server-side, distinguishes what to ingest).
 * - `parentId` is the document id for `kind: "document"` (section 40's
 *   connector imports).
 */

export type IngestKind = "transcript" | "summary" | "document";

export type IngestJob = "index" | "summarize";

export interface IngestMessage {
  /** Owner of the parent row (sessions.user_id / documents.user_id). */
  userId: string;
  kind: IngestKind;
  /** sessions.id for transcript AND summary kinds; document id for documents. */
  parentId: string;
  /**
   * Server-side monotonic revision counter at write time
   * (sessions.transcript_revision / summaries.revision) — NEVER epoch ms.
   * Consumers compare against the current row's revision and drop stale
   * messages.
   */
  sourceRevision: number;
  /** Optionally narrows what consumers do (default: all applicable). */
  jobs?: IngestJob[];
  /** Optional correlation id for request-scoped flows (e.g. Ask-AI). */
  requestId?: string;
}
