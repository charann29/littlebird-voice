import { applyD1Migrations, env } from "cloudflare:test";

// Apply all D1 migrations before any test runs (fresh per-test isolated
// storage is provided by @cloudflare/vitest-pool-workers).
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
