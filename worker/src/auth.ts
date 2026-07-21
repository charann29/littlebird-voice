/**
 * Shared-bearer-token auth middleware.
 *
 * Compares `Authorization: Bearer <token>` against the `APP_AUTH_TOKEN`
 * secret with a timing-safe comparison and resolves the request to the single
 * seeded MVP user, setting `c.var.userId`. Every handler reads
 * `c.var.userId` — the upgrade path to multi-user is swapping this middleware
 * for a per-user session lookup; nothing else changes.
 */

import type { MiddlewareHandler } from "hono";
import type { Env } from "./env";
import { errorBody } from "./errors";

/** Fixed id of the single MVP user — matches the seed row in 0001_init.sql. */
export const SINGLE_USER_ID = "00000000-0000-4000-8000-000000000001";

export type AuthVariables = { userId: string };

/** Constant-time string comparison (length leak only). */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export const authMiddleware: MiddlewareHandler<{
  Bindings: Env;
  Variables: AuthVariables;
}> = async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const expected = c.env.APP_AUTH_TOKEN;
  if (!expected || !token || !timingSafeEqual(token, expected)) {
    return c.json(errorBody("unauthorized", "Missing or invalid bearer token"), 401);
  }
  c.set("userId", SINGLE_USER_ID);
  await next();
};
