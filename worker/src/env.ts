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

  // --- Integrations (section 40, Track B) ------------------------------------
  // ALL optional: local dev must boot and serve every non-integration route
  // (and the integrations list endpoint) without any provider credentials.
  // Missing secrets only surface when the user invokes Connect → 501
  // not_configured.

  /** Public base URL of the app (redirect target after OAuth callbacks).
   *  Local dev default: http://localhost:5173 (vite dev server). */
  APP_BASE_URL?: string;
  /** Public base URL of this Worker (OAuth redirect_uri base). Never derived
   *  from the incoming Host header. Local dev default: http://localhost:8787. */
  WORKER_BASE_URL?: string;
  /** 32 bytes base64 — AES-256-GCM key for token ciphertext (secret). */
  INTEGRATIONS_TOKEN_KEY?: string;
  /** HMAC-SHA256 key for OAuth state signing (secret). */
  OAUTH_STATE_SIGNING_KEY?: string;
  /** Google OAuth app (Calendar + Gmail connectors share it). */
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  /** Slack app (bot token flow, rotation disabled). */
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  /** Notion public integration. */
  NOTION_CLIENT_ID?: string;
  NOTION_CLIENT_SECRET?: string;
  /** Calendar auto-create cron lookahead in hours (default 24). */
  CALENDAR_AUTOCREATE_WINDOW_HOURS?: string;
  /**
   * "1" = deterministic local-dev AI: hash embeddings (section 30) AND the
   * stub LLM provider (section 20) instead of Workers AI. Never in prod.
   */
  DEV_FAKE_AI?: string;
}
