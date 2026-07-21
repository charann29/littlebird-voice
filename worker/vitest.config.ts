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
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
