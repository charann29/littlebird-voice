/**
 * Internal memory-document ingestion service (30-T3 seam, shared with
 * section 40's Notion import).
 *
 * `ingestMemoryDocument(env, userId, input)` is the SINGLE place a memory
 * document is upserted and its ingest enqueued: the HTTP route
 * (POST /api/memory/documents) validates input then delegates here, and the
 * Notion import connector calls it directly as the plan's "internal
 * document-ingest service" (module-level call, not HTTP).
 *
 * Semantics (unchanged from the original inline route logic):
 * - With `external_id`: idempotent upsert keyed on
 *   (user_id, source, external_id) — re-import updates the row and bumps
 *   `revision` instead of duplicating.
 * - Without `external_id`: always inserts a new document.
 * - Always enqueues an `IngestMessage` (kind "document", jobs ["index"]) so
 *   chunking/embedding happens asynchronously.
 */

import type { Env } from "../env";

/** Canonical document input (shared with section 40 connectors). */
export interface MemoryDocumentInput {
  title: string;
  source: string;
  text: string;
  external_id?: string;
  metadata?: object;
}

export interface MemoryDocumentResult {
  id: string;
  revision: number;
}

/** Upsert a memory document for `userId` and enqueue its (re)ingest. */
export async function ingestMemoryDocument(
  env: Env,
  userId: string,
  input: MemoryDocumentInput,
): Promise<MemoryDocumentResult> {
  const externalId =
    typeof input.external_id === "string" && input.external_id.trim()
      ? input.external_id
      : null;
  const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;
  const now = Date.now();

  let row: MemoryDocumentResult | null;
  if (externalId !== null) {
    // Idempotent upsert per (user_id, source, external_id).
    row = await env.DB.prepare(
      `INSERT INTO memory_documents
         (id, user_id, title, source, external_id, text, metadata_json, revision, chunk_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
       ON CONFLICT (user_id, source, external_id) WHERE external_id IS NOT NULL
       DO UPDATE SET
         title = excluded.title,
         text = excluded.text,
         metadata_json = excluded.metadata_json,
         revision = memory_documents.revision + 1,
         updated_at = excluded.updated_at
       RETURNING id, revision`,
    )
      .bind(
        crypto.randomUUID(),
        userId,
        input.title,
        input.source,
        externalId,
        input.text,
        metadataJson,
        now,
        now,
      )
      .first<MemoryDocumentResult>();
  } else {
    // One-off upload: always a new document.
    row = await env.DB.prepare(
      `INSERT INTO memory_documents
         (id, user_id, title, source, external_id, text, metadata_json, revision, chunk_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, 1, 0, ?, ?)
       RETURNING id, revision`,
    )
      .bind(
        crypto.randomUUID(),
        userId,
        input.title,
        input.source,
        input.text,
        metadataJson,
        now,
        now,
      )
      .first<MemoryDocumentResult>();
  }
  if (!row) {
    throw new Error("Document upsert returned no row");
  }

  await env.INGEST_QUEUE.send({
    userId,
    kind: "document",
    parentId: row.id,
    sourceRevision: row.revision,
    jobs: ["index"],
  });

  return row;
}
