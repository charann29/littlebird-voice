/**
 * Shared fixtures/mocks for section 30 (memory) tests.
 */

import { env } from "cloudflare:test";
import { SINGLE_USER_ID } from "../src/auth";
import {
  DevHashEmbeddingProvider,
  type EmbeddingProvider,
} from "../src/memory/provider";
import {
  DevD1MemoryIndex,
  type MemoryIndex,
  type VectorFilter,
  type VectorMatch,
  type VectorRecord,
} from "../src/memory/index-store";

export { SINGLE_USER_ID };

/** Mock provider: deterministic hash vectors + call recording. */
export class RecordingProvider implements EmbeddingProvider {
  readonly modelId = "test/mock-embedding";
  readonly dimensions = 1024;
  /** Every batch of texts passed to embed(). */
  embedCalls: string[][] = [];
  private inner = new DevHashEmbeddingProvider();

  async embed(texts: string[]): Promise<number[][]> {
    this.embedCalls.push(texts);
    return this.inner.embed(texts);
  }

  get embeddedTextCount(): number {
    return this.embedCalls.reduce((n, batch) => n + batch.length, 0);
  }
}

/** MemoryIndex spy over the real D1 dev index (records mutation calls). */
export class RecordingIndex implements MemoryIndex {
  upsertCalls: { namespace: string; ids: string[] }[] = [];
  deleteCalls: string[][] = [];
  private inner = new DevD1MemoryIndex(env.DB);

  async upsert(namespace: string, vectors: VectorRecord[]): Promise<void> {
    this.upsertCalls.push({ namespace, ids: vectors.map((v) => v.id) });
    return this.inner.upsert(namespace, vectors);
  }

  async query(
    namespace: string,
    vector: number[],
    opts: { topK: number; filter?: VectorFilter },
  ): Promise<VectorMatch[]> {
    return this.inner.query(namespace, vector, opts);
  }

  async deleteByIds(ids: string[]): Promise<void> {
    this.deleteCalls.push(ids);
    return this.inner.deleteByIds(ids);
  }
}

/** Insert a session row owned by `userId` (defaults to the MVP user). */
export async function seedSession(
  id: string,
  opts: { title?: string; createdAt?: number; userId?: string } = {},
): Promise<void> {
  const userId = opts.userId ?? SINGLE_USER_ID;
  if (userId !== SINGLE_USER_ID) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO users (id, email, name, created_at) VALUES (?, NULL, 'Other', 0)",
    )
      .bind(userId)
      .run();
  }
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, title, source, status, created_at, updated_at, duration_ms)
     VALUES (?, ?, ?, 'mic', 'done', ?, ?, 1000)`,
  )
    .bind(id, userId, opts.title ?? "Test session", opts.createdAt ?? Date.now(), Date.now())
    .run();
}

/** Insert transcript segments (bumps nothing — pair with a revision arg). */
export async function seedSegments(
  sessionId: string,
  segments: { speaker?: string | null; text: string; start_ms?: number; end_ms?: number }[],
): Promise<void> {
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    await env.DB.prepare(
      `INSERT INTO transcript_segments (session_id, seq, speaker, start_ms, end_ms, text)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        sessionId,
        i,
        seg.speaker ?? null,
        seg.start_ms ?? i * 1000,
        seg.end_ms ?? i * 1000 + 900,
        seg.text,
      )
      .run();
  }
}

/** Replace all segments for a session (simulates re-transcription). */
export async function replaceSegments(
  sessionId: string,
  segments: { speaker?: string | null; text: string }[],
): Promise<void> {
  await env.DB.prepare("DELETE FROM transcript_segments WHERE session_id = ?")
    .bind(sessionId)
    .run();
  await seedSegments(sessionId, segments);
}

/** Count memory_chunks rows for a (session|document, kind). */
export async function chunkCount(
  parentId: string,
  kind: "transcript" | "summary" | "document",
): Promise<number> {
  const column = kind === "document" ? "document_id" : "session_id";
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM memory_chunks WHERE ${column} = ? AND kind = ?`,
  )
    .bind(parentId, kind)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
