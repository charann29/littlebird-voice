import path from "node:path";
import fs from "node:fs";
import {
  defineWorkersConfig,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(
    path.join(__dirname, "migrations"),
  );
  // The assets binding in wrangler.jsonc points at ../dist; make sure it
  // exists even when the frontend has not been built (tests never hit it).
  fs.mkdirSync(path.join(__dirname, "../dist"), { recursive: true });

  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              APP_AUTH_TOKEN: "test-app-token",
              SONIOX_API_KEY: "test-soniox-key",
            },
          },
        },
      },
    },
  };
});
