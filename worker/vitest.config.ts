import path from "node:path";
import fs from "node:fs";
import { defineConfig } from "vitest/config";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
  // The assets binding in wrangler.jsonc points at ../dist; make sure it
  // exists even when the frontend has not been built (tests never hit it).
  fs.mkdirSync(path.join(__dirname, "../dist"), { recursive: true });

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            APP_AUTH_TOKEN: "test-app-token",
            SONIOX_API_KEY: "test-soniox-key",
            // Section 30 local seams: deterministic hash embeddings + the
            // D1-backed dev vector index (no Vectorize/Workers AI in tests).
            DEV_FAKE_AI: "1",
            DEV_LOCAL_VECTOR: "1",
            // Section 40 (integrations): deterministic test keys + fake
            // Google OAuth app; provider HTTP is mocked via stubbed fetch.
            INTEGRATIONS_TOKEN_KEY: "9jJVsRLZ9AsGGxvsIZ3HYyWDL4WYAY1TQK+I2AhQfvM=",
            OAUTH_STATE_SIGNING_KEY: "test-state-signing-key",
            GOOGLE_OAUTH_CLIENT_ID: "test-google-client-id",
            GOOGLE_OAUTH_CLIENT_SECRET: "test-google-client-secret",
            APP_BASE_URL: "https://app.example.com",
            WORKER_BASE_URL: "https://worker.example.com",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
