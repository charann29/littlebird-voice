import type { Env } from "../src/env";

declare module "cloudflare:test" {
  // ProvidedEnv is what `import { env } from "cloudflare:test"` resolves to.
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}
