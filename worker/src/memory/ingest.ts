/**
 * Memory ingestion pipeline (section 30).
 *
 * `ingestMemory(env, msg)` — the queue job. Steps (per plan):
 *  1. sourceRevision guard: existing chunks for (parentId, kind) with a HIGHER
 *     source_revision mean a newer ingest already completed — skip (ack).
 *  2. Re-read CURRENT content from D1 (messages carry no text), chunk, hash.
 *  3. Hash-diff against existing rows: unchanged chunks skip re-embedding
 *     (idempotent under at-least-once delivery); changed/new chunks are
 *     (re)embedded; rows beyond the new chunk count are deleted from D1 + the
 *     vector index. Rows are written BEFORE embedding so a mid-pipeline
 *     failure leaves keyword search working (embedded_at IS NULL marks the
 *     recovery work).
 *  4. Upsert vectors (namespace = userId, deterministic id
 *     `${parentId}:${kind}:${chunkIndex}`), then set embedded_at /
 *     embedding_model, and persist chunk_count for document ingests.
 *
 * `deleteMemoryFor(env, ref)` — deletion propagation (called by the session
 * DELETE route and the documents DELETE route).
 *
 * `reindexMemory(env, userId, sessionId?)` — recovery sweep re-running
 * ingestion from source content.
 */

import type { Env } from "../env";
import type { IngestMessage, IngestKind } from "../services/ingest-message";
import {
  chunkTranscript,
  chunkText,
  contentHash,
  type Chunk,
} from "./chunking";
import { getEmbeddingProvider, type EmbeddingProvider } from "./provider";
import {
  getMemoryIndex,
  type MemoryIndex,
  type VectorMetadata,
  type VectorRecord,
} from "./index-store";

/** Optional dependency overrides (tests inject mocks here). */
export interface IngestDeps {
  provider?: EmbeddingProvider;
  index?: MemoryIndex;
}

export type IngestResult =
  | { status: "ok"; chunks: number }
  | { status: "skipped_stale" }
  | { status: "parent_missing" };

interface ChunkRow {
  id: string;
  chunk_index: number;
  content_hash: string;
  source_revision: number;
  embedded_at: number | null;
}

/** Render a summary JSON payload to plain indexable text (deterministic). */
export function summaryPayloadToText(payload: unknown): string {
  if (payload == null) return "";
  if (typeof payload === "string") return payload;
  if (typeof payload === "number" || typeof payload === "boolean") {
    return String(payload);
  }
  if (Array.isArray(payload)) {
    return payload
      .map((item) => summaryPayloadToText(item))
      .filter((s) => s.length > 0)
      .join("\n");
  }
  const lines: string[] = [];
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    const text = summaryPayloadToText(value);
    if (!text) continue;
    lines.push(text.includes("\n") ? `${key}:\n${text}` : `${key}: ${text}`);
  }
  return lines.join("\n\n");
}

interface SourceContent {
  chunks: Chunk[];
  /** Parent created_at (epoch ms). */
  createdAt: number;
}

/**
 * Re-read the CURRENT parent content from D1 and chunk it. Returns null when
 * the parent row no longer exists (deleted before the consumer ran).
 */
async function loadSourceChunks(
  env: Env,
  userId: string,
  kind: IngestKind,
  parentId: string,
): Promise<SourceContent | null> {
  if (kind === "document") {
    const doc = await env.DB.prepare(
      "SELECT text, created_at FROM memory_documents WHERE id = ? AND user_id = ?",
    )
      .bind(parentId, userId)
      .first<{ text: string; created_at: number }>();
    if (!doc) return null;
    return { chunks: chunkText(doc.text), createdAt: doc.created_at };
  }

  const session = await env.DB.prepare(
    "SELECT created_at FROM sessions WHERE id = ? AND user_id = ?",
  )
    .bind(parentId, userId)
    .first<{ created_at: number }>();
  if (!session) return null;

  if (kind === "transcript") {
    const { results } = await env.DB.prepare(
      `SELECT speaker, start_ms, end_ms, text FROM transcript_segments
       WHERE session_id = ? ORDER BY seq`,
    )
      .bind(parentId)
      .all<{ speaker: string | null; start_ms: number | null; end_ms: number | null; text: string }>();
    return { chunks: chunkTranscript(results), createdAt: session.created_at };
  }

  // kind === "summary": all summary rows for the session (ordered by kind for
  // determinism), rendered to text and chunked in paragraph mode.
  const { results } = await env.DB.prepare(
    "SELECT kind, payload_json FROM summaries WHERE session_id = ? ORDER BY kind",
  )
    .bind(parentId)
    .all<{ kind: string; payload_json: string }>();
  const text = results
    .map((r) => summaryPayloadToText(JSON.parse(r.payload_json)))
    .filter((t) => t.length > 0)
    .join("\n\n");
  return { chunks: chunkText(text), createdAt: session.created_at };
}

function existingChunksQuery(env: Env, kind: IngestKind, parentId: string) {
  return kind === "document"
    ? env.DB.prepare(
        `SELECT id, chunk_index, content_hash, source_revision, embedded_at
         FROM memory_chunks WHERE document_id = ? AND kind = 'document'
         ORDER BY chunk_index`,
      ).bind(parentId)
    : env.DB.prepare(
        `SELECT id, chunk_index, content_hash, source_revision, embedded_at
         FROM memory_chunks WHERE session_id = ? AND kind = ?
         ORDER BY chunk_index`,
      ).bind(parentId, kind);
}

/** Queue job: chunk + embed + index one parent's current content. */
export async function ingestMemory(
  env: Env,
  msg: IngestMessage,
  deps: IngestDeps = {},
): Promise<IngestResult> {
  const { userId, kind, parentId, sourceRevision } = msg;
  const index = deps.index ?? getMemoryIndex(env);

  // 1. Ordering guard: a newer ingest already completed → skip.
  const existing = (await existingChunksQuery(env, kind, parentId).all<ChunkRow>())
    .results;
  if (existing.some((row) => row.source_revision > sourceRevision)) {
    return { status: "skipped_stale" };
  }

  // 2. Re-read current content.
  const source = await loadSourceChunks(env, userId, kind, parentId);
  if (source === null) {
    // Parent deleted before the consumer ran — clean up any leftovers.
    await deleteMemoryFor(
      env,
      kind === "document" ? { document_id: parentId } : { session_id: parentId },
      deps,
    );
    return { status: "parent_missing" };
  }

  const { chunks, createdAt } = source;
  const now = Date.now();
  const existingById = new Map(existing.map((row) => [row.id, row]));

  // 3. Hash-diff.
  const hashes = await Promise.all(chunks.map((c) => contentHash(c.text)));
  const toEmbed: number[] = []; // indexes into `chunks`
  const statements: D1PreparedStatement[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const id = `${parentId}:${kind}:${i}`;
    const prev = existingById.get(id);
    if (prev && prev.content_hash === hashes[i] && prev.embedded_at !== null) {
      // Unchanged and already embedded — just record the newer revision.
      if (prev.source_revision !== sourceRevision) {
        statements.push(
          env.DB.prepare(
            "UPDATE memory_chunks SET source_revision = ? WHERE id = ?",
          ).bind(sourceRevision, id),
        );
      }
      continue;
    }
    toEmbed.push(i);
    const chunk = chunks[i];
    statements.push(
      env.DB.prepare(
        `INSERT INTO memory_chunks (id, user_id, kind, session_id, document_id,
           chunk_index, text, speaker, start_ms, end_ms, content_hash,
           source_revision, embedding_model, embedded_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
         ON CONFLICT (id) DO UPDATE SET
           text = excluded.text,
           speaker = excluded.speaker,
           start_ms = excluded.start_ms,
           end_ms = excluded.end_ms,
           content_hash = excluded.content_hash,
           source_revision = excluded.source_revision,
           embedding_model = NULL,
           embedded_at = NULL,
           created_at = excluded.created_at`,
      ).bind(
        id,
        userId,
        kind,
        kind === "document" ? null : parentId,
        kind === "document" ? parentId : null,
        i,
        chunk.text,
        chunk.speaker,
        chunk.start_ms,
        chunk.end_ms,
        hashes[i],
        sourceRevision,
        createdAt,
      ),
    );
  }

  // Rows beyond the new chunk count are stale — remove from D1 + index.
  const staleIds = existing
    .filter((row) => row.chunk_index >= chunks.length)
    .map((row) => row.id);
  for (const id of staleIds) {
    statements.push(
      env.DB.prepare("DELETE FROM memory_chunks WHERE id = ?").bind(id),
    );
  }

  // Rows written BEFORE embedding (keyword search survives embed failures).
  if (statements.length > 0) await env.DB.batch(statements);
  if (staleIds.length > 0) await index.deleteByIds(staleIds);

  // 4. Embed changed chunks + upsert vectors.
  if (toEmbed.length > 0) {
    const provider = deps.provider ?? getEmbeddingProvider(env);
    const vectors = await provider.embed(toEmbed.map((i) => chunks[i].text));
    const createdAtSec = Math.floor(createdAt / 1000);
    const records: VectorRecord[] = toEmbed.map((chunkIdx, j) => {
      const chunk = chunks[chunkIdx];
      const metadata: VectorMetadata = {
        user_id: userId,
        kind,
        created_at: createdAtSec,
        ...(kind === "document"
          ? { document_id: parentId }
          : { session_id: parentId }),
        ...(chunk.speaker != null ? { speaker: chunk.speaker } : {}),
        ...(chunk.start_ms != null ? { start_ms: chunk.start_ms } : {}),
        ...(chunk.end_ms != null ? { end_ms: chunk.end_ms } : {}),
      };
      return {
        id: `${parentId}:${kind}:${chunkIdx}`,
        values: vectors[j],
        metadata,
      };
    });
    await index.upsert(userId, records);

    await env.DB.batch(
      toEmbed.map((chunkIdx) =>
        env.DB.prepare(
          "UPDATE memory_chunks SET embedded_at = ?, embedding_model = ? WHERE id = ?",
        ).bind(now, provider.modelId, `${parentId}:${kind}:${chunkIdx}`),
      ),
    );
  }

  // 5. Persist chunk_count for document ingests (read by GET /documents/:id).
  if (kind === "document") {
    await env.DB.prepare(
      "UPDATE memory_documents SET chunk_count = ? WHERE id = ?",
    )
      .bind(chunks.length, parentId)
      .run();
  }

  return { status: "ok", chunks: chunks.length };
}

/** Deletion propagation: remove all chunks + vectors for a session/document. */
export async function deleteMemoryFor(
  env: Env,
  ref: { session_id?: string; document_id?: string },
  deps: IngestDeps = {},
): Promise<{ deleted: number }> {
  const index = deps.index ?? getMemoryIndex(env);
  const [column, value] = ref.session_id
    ? ["session_id", ref.session_id]
    : ["document_id", ref.document_id];
  if (!value) return { deleted: 0 };

  const { results } = await env.DB.prepare(
    `SELECT id FROM memory_chunks WHERE ${column} = ?`,
  )
    .bind(value)
    .all<{ id: string }>();
  const ids = results.map((r) => r.id);
  if (ids.length === 0) return { deleted: 0 };

  await index.deleteByIds(ids);
  // FTS triggers clean the virtual table on row delete.
  await env.DB.prepare(`DELETE FROM memory_chunks WHERE ${column} = ?`)
    .bind(value)
    .run();
  return { deleted: ids.length };
}

/**
 * Recovery sweep: re-run ingestion from source content. Covers chunks with
 * `embedded_at IS NULL` AND parents with zero chunk rows (e.g. dead-lettered
 * messages) — the D1 source rows are the ground truth.
 */
export async function reindexMemory(
  env: Env,
  userId: string,
  sessionId?: string,
  deps: IngestDeps = {},
): Promise<{ reindexed: number }> {
  const targets: { kind: IngestKind; parentId: string; revision: number }[] = [];

  if (sessionId) {
    const session = await env.DB.prepare(
      "SELECT id, transcript_revision FROM sessions WHERE id = ? AND user_id = ?",
    )
      .bind(sessionId, userId)
      .first<{ id: string; transcript_revision: number }>();
    if (!session) return { reindexed: 0 };
    targets.push({
      kind: "transcript",
      parentId: sessionId,
      revision: session.transcript_revision,
    });
    const summary = await env.DB.prepare(
      "SELECT MAX(revision) AS revision FROM summaries WHERE session_id = ?",
    )
      .bind(sessionId)
      .first<{ revision: number | null }>();
    if (summary?.revision != null) {
      targets.push({ kind: "summary", parentId: sessionId, revision: summary.revision });
    }
  } else {
    const sessions = await env.DB.prepare(
      `SELECT s.id, s.transcript_revision,
              (SELECT COUNT(*) FROM transcript_segments t WHERE t.session_id = s.id) AS seg_count,
              (SELECT MAX(revision) FROM summaries m WHERE m.session_id = s.id) AS summary_revision
       FROM sessions s WHERE s.user_id = ?`,
    )
      .bind(userId)
      .all<{
        id: string;
        transcript_revision: number;
        seg_count: number;
        summary_revision: number | null;
      }>();
    for (const row of sessions.results) {
      if (row.seg_count > 0) {
        targets.push({
          kind: "transcript",
          parentId: row.id,
          revision: row.transcript_revision,
        });
      }
      if (row.summary_revision != null) {
        targets.push({
          kind: "summary",
          parentId: row.id,
          revision: row.summary_revision,
        });
      }
    }
    const docs = await env.DB.prepare(
      "SELECT id, revision FROM memory_documents WHERE user_id = ?",
    )
      .bind(userId)
      .all<{ id: string; revision: number }>();
    for (const doc of docs.results) {
      targets.push({ kind: "document", parentId: doc.id, revision: doc.revision });
    }
  }

  let reindexed = 0;
  for (const target of targets) {
    const result = await ingestMemory(
      env,
      {
        userId,
        kind: target.kind,
        parentId: target.parentId,
        sourceRevision: target.revision,
      },
      deps,
    );
    if (result.status === "ok") reindexed++;
  }
  return { reindexed };
}
