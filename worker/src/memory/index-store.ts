/**
 * MemoryIndex seam — thin wrapper over the vector store (section 30).
 *
 * - `VectorizeMemoryIndex` — the real store: Cloudflare Vectorize index
 *   `littlebird-memory` (1024 dims, cosine, namespace = user_id). Vectorize
 *   has NO local simulator, so this only runs deployed / with credentials.
 * - `DevD1MemoryIndex` — LOCAL-DEV/TEST fallback (DEV_LOCAL_VECTOR=1): stores
 *   vectors in the `memory_vectors_dev` D1 table and does brute-force cosine
 *   in JS. Fine at dev scale; supports the same namespace + metadata filters
 *   the search layer uses ({kind: {$in}, session_id: {$eq}, created_at:
 *   {$gte,$lte}}).
 *
 * `getMemoryIndex(env)` picks the implementation from env.
 */

import type { Env } from "../env";

/** Metadata stored per vector (tiny — canonical text lives in D1). */
export interface VectorMetadata {
  user_id: string;
  kind: "transcript" | "summary" | "document";
  session_id?: string;
  document_id?: string;
  /** Parent created_at, unix SECONDS (Vectorize numeric range filter). */
  created_at: number;
  speaker?: string;
  start_ms?: number;
  end_ms?: number;
  [key: string]: string | number | undefined;
}

export interface VectorRecord {
  id: string;
  values: number[];
  metadata: VectorMetadata;
}

/** Filter subset used by searchMemory (mirrors Vectorize filter syntax). */
export interface VectorFilter {
  kind?: { $in: string[] };
  session_id?: { $eq: string };
  created_at?: { $gte?: number; $lte?: number };
}

export interface VectorMatch {
  id: string;
  /** Cosine similarity score. */
  score: number;
  metadata?: VectorMetadata;
}

export interface MemoryIndex {
  upsert(namespace: string, vectors: VectorRecord[]): Promise<void>;
  query(
    namespace: string,
    vector: number[],
    opts: { topK: number; filter?: VectorFilter },
  ): Promise<VectorMatch[]>;
  deleteByIds(ids: string[]): Promise<void>;
}

/** Vectorize deleteByIds batch limit. */
const DELETE_BATCH = 1000;

export class VectorizeMemoryIndex implements MemoryIndex {
  constructor(private index: Vectorize) {}

  async upsert(namespace: string, vectors: VectorRecord[]): Promise<void> {
    if (vectors.length === 0) return;
    await this.index.upsert(
      vectors.map((v) => ({
        id: v.id,
        values: v.values,
        namespace,
        metadata: v.metadata as Record<string, string | number>,
      })),
    );
  }

  async query(
    namespace: string,
    vector: number[],
    opts: { topK: number; filter?: VectorFilter },
  ): Promise<VectorMatch[]> {
    const res = await this.index.query(vector, {
      namespace,
      topK: opts.topK,
      returnMetadata: "all",
      ...(opts.filter ? { filter: opts.filter as VectorizeVectorMetadataFilter } : {}),
    });
    return res.matches.map((m) => ({
      id: m.id,
      score: m.score,
      metadata: m.metadata as VectorMetadata | undefined,
    }));
  }

  async deleteByIds(ids: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += DELETE_BATCH) {
      await this.index.deleteByIds(ids.slice(i, i + DELETE_BATCH));
    }
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function matchesFilter(meta: VectorMetadata, filter?: VectorFilter): boolean {
  if (!filter) return true;
  if (filter.kind && !filter.kind.$in.includes(meta.kind)) return false;
  if (filter.session_id && meta.session_id !== filter.session_id.$eq) {
    return false;
  }
  if (filter.created_at) {
    const { $gte, $lte } = filter.created_at;
    if ($gte !== undefined && meta.created_at < $gte) return false;
    if ($lte !== undefined && meta.created_at > $lte) return false;
  }
  return true;
}

/** D1-backed brute-force index for local dev (DEV_LOCAL_VECTOR=1). */
export class DevD1MemoryIndex implements MemoryIndex {
  constructor(private db: D1Database) {}

  async upsert(namespace: string, vectors: VectorRecord[]): Promise<void> {
    if (vectors.length === 0) return;
    await this.db.batch(
      vectors.map((v) =>
        this.db
          .prepare(
            `INSERT INTO memory_vectors_dev (id, namespace, vector_json, metadata_json)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET
               namespace = excluded.namespace,
               vector_json = excluded.vector_json,
               metadata_json = excluded.metadata_json`,
          )
          .bind(v.id, namespace, JSON.stringify(v.values), JSON.stringify(v.metadata)),
      ),
    );
  }

  async query(
    namespace: string,
    vector: number[],
    opts: { topK: number; filter?: VectorFilter },
  ): Promise<VectorMatch[]> {
    const { results } = await this.db
      .prepare(
        "SELECT id, vector_json, metadata_json FROM memory_vectors_dev WHERE namespace = ?",
      )
      .bind(namespace)
      .all<{ id: string; vector_json: string; metadata_json: string | null }>();

    const scored: VectorMatch[] = [];
    for (const row of results) {
      const metadata = row.metadata_json
        ? (JSON.parse(row.metadata_json) as VectorMetadata)
        : undefined;
      if (metadata && !matchesFilter(metadata, opts.filter)) continue;
      if (!metadata && opts.filter) continue;
      scored.push({
        id: row.id,
        score: cosine(vector, JSON.parse(row.vector_json) as number[]),
        metadata,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, opts.topK);
  }

  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    for (let i = 0; i < ids.length; i += DELETE_BATCH) {
      const batch = ids.slice(i, i + DELETE_BATCH);
      await this.db
        .prepare(
          `DELETE FROM memory_vectors_dev WHERE id IN (${batch.map(() => "?").join(",")})`,
        )
        .bind(...batch)
        .run();
    }
  }
}

/** Select the vector index from env (DEV_LOCAL_VECTOR=1 → D1 dev index). */
export function getMemoryIndex(env: Env): MemoryIndex {
  if (env.DEV_LOCAL_VECTOR === "1") return new DevD1MemoryIndex(env.DB);
  if (!env.VECTORIZE) {
    throw new Error(
      "VECTORIZE binding missing — set DEV_LOCAL_VECTOR=1 in .dev.vars for " +
        "local dev or enable the vectorize binding in wrangler.jsonc for deploys",
    );
  }
  return new VectorizeMemoryIndex(env.VECTORIZE);
}
