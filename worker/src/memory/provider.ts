/**
 * Embedding provider seam (section 30).
 *
 * - `WorkersAiEmbeddingProvider` — the real provider: Workers AI
 *   `@cf/baai/bge-m3` (1024-dim, multilingual — covers en/hi/te). Requires the
 *   `AI` binding, which has no local simulator (calls the real API even in
 *   `wrangler dev`), so it only runs with Cloudflare credentials.
 * - `DevHashEmbeddingProvider` — LOCAL-DEV/TEST fallback (DEV_FAKE_AI=1):
 *   deterministic hash-based pseudo-embedding. Same text → same vector;
 *   texts sharing tokens get correlated vectors, so cosine ranking behaves
 *   sensibly enough for dev. NOT semantically meaningful.
 *
 * `getEmbeddingProvider(env)` picks the implementation from env. Chunk rows
 * store `embedding_model`, so switching providers later can detect and
 * reindex stale vectors.
 */

import type { Env } from "../env";

export interface EmbeddingProvider {
  /** Stable model identifier persisted on chunk rows. */
  modelId: string;
  /** Vector dimensionality (must match the vector index). */
  dimensions: number;
  /** Embed a batch of texts (order-preserving). */
  embed(texts: string[]): Promise<number[][]>;
}

export const EMBEDDING_DIMENSIONS = 1024;
export const WORKERS_AI_EMBEDDING_MODEL = "@cf/baai/bge-m3";
export const DEV_EMBEDDING_MODEL = "dev/hash-embedding-v1";

/** Workers AI batch limit for bge-m3 (texts per call). */
const EMBED_BATCH_SIZE = 100;

/** Minimal shape of the bge-m3 dense-embedding response. */
interface BgeM3Response {
  data?: number[][];
}

export class WorkersAiEmbeddingProvider implements EmbeddingProvider {
  readonly modelId = WORKERS_AI_EMBEDDING_MODEL;
  readonly dimensions = EMBEDDING_DIMENSIONS;

  constructor(private ai: Ai) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
      const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
      const res = (await this.ai.run(
        this.modelId as Parameters<Ai["run"]>[0],
        { text: batch } as never,
      )) as BgeM3Response;
      if (!res?.data || res.data.length !== batch.length) {
        throw new Error(
          `Embedding call returned ${res?.data?.length ?? 0} vectors for ${batch.length} texts`,
        );
      }
      out.push(...res.data);
    }
    return out;
  }
}

/** FNV-1a 32-bit hash (deterministic, dependency-free). */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic pseudo-embedding: token hashing into a fixed-size bag-of-words
 * vector (with a couple of hash seeds per token), L2-normalized. Shared tokens
 * between texts → higher cosine similarity, so relevance ordering in dev is
 * plausible. Unicode-aware tokenization keeps hi/te text working.
 */
export class DevHashEmbeddingProvider implements EmbeddingProvider {
  readonly modelId = DEV_EMBEDDING_MODEL;
  readonly dimensions = EMBEDDING_DIMENSIONS;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const vec = new Float64Array(this.dimensions);
    const tokens = text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 0);
    for (const token of tokens) {
      // Two hash projections per token reduce collisions.
      vec[fnv1a(token) % this.dimensions] += 1;
      vec[fnv1a(`salt:${token}`) % this.dimensions] += 0.5;
    }
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    return [...vec].map((v) => v / norm);
  }
}

/** Select the embedding provider from env (DEV_FAKE_AI=1 → hash fallback). */
export function getEmbeddingProvider(env: Env): EmbeddingProvider {
  if (env.DEV_FAKE_AI === "1") return new DevHashEmbeddingProvider();
  if (!env.AI) {
    throw new Error(
      "AI binding missing — set DEV_FAKE_AI=1 in .dev.vars for local dev " +
        "or enable the ai binding in wrangler.jsonc for deploys",
    );
  }
  return new WorkersAiEmbeddingProvider(env.AI);
}
