/**
 * Worker environment bindings + secrets. Extend by adding fields here AND the
 * matching binding in `wrangler.jsonc` (or a secret via `wrangler secret put`
 * / `.dev.vars` for local dev).
 */

import type { IngestMessage } from "./services/ingest-message";

export interface Env {
  /** D1 database (tables: users, sessions, transcript_segments, summaries). */
  DB: D1Database;
  /** Static assets binding serving the built PWA (../dist). */
  ASSETS: Fetcher;
  /** Producer for the `littlebird-ingest` queue (consumed by sections 20/30). */
  INGEST_QUEUE: Queue<IngestMessage>;
  /**
   * Vectorize index `littlebird-memory` (1024 dims, cosine). Optional because
   * Vectorize has NO local simulator — local dev sets DEV_LOCAL_VECTOR=1 and
   * uses the D1-backed dev index instead (see src/memory/index-store.ts).
   */
  VECTORIZE?: Vectorize;
  /**
   * Workers AI binding (section 30 embeddings: @cf/baai/bge-m3; section 20
   * LLM calls via src/ai/provider.ts). Optional because local dev without
   * Cloudflare credentials sets DEV_FAKE_AI=1 and uses deterministic
   * fallbacks (hash embeddings in src/memory/provider.ts, stub LLM in
   * src/ai/provider.ts).
   */
  AI?: Ai;
  /**
   * LLM model id for section 20 (default
   * @cf/meta/llama-3.3-70b-instruct-fp8-fast) — never hardcoded at call sites.
   */
  AI_MODEL?: string;
  /** Permanent Soniox API key (secret) — never leaves the Worker. */
  SONIOX_API_KEY: string;
  /** Shared bearer token for all /api/* routes except /api/health (secret). */
  APP_AUTH_TOKEN: string;
  /** "1" = use the D1-backed local dev vector index instead of Vectorize. */
  DEV_LOCAL_VECTOR?: string;
  /**
   * "1" = deterministic local-dev AI: hash embeddings (section 30) AND the
   * stub LLM provider (section 20) instead of Workers AI. Never in prod.
   */
  DEV_FAKE_AI?: string;
}
