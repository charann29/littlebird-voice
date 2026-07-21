import type { IngestMessage } from "../src/services/ingest-message";

declare global {
  namespace Cloudflare {
    // `import { env } from "cloudflare:test"` resolves to Cloudflare.Env;
    // augment it with our bindings + the migrations array injected by
    // vitest.config.ts.
    interface Env {
      DB: D1Database;
      ASSETS: Fetcher;
      INGEST_QUEUE: Queue<IngestMessage>;
      SONIOX_API_KEY: string;
      APP_AUTH_TOKEN: string;
      DEV_FAKE_AI: string;
      DEV_LOCAL_VECTOR: string;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
