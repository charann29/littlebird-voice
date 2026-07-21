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
  /** Permanent Soniox API key (secret) — never leaves the Worker. */
  SONIOX_API_KEY: string;
  /** Shared bearer token for all /api/* routes except /api/health (secret). */
  APP_AUTH_TOKEN: string;
}
