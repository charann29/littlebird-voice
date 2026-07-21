/**
 * Canonical error schema: every non-2xx JSON response is
 * `{ "error": { "code": string, "message": string } }`.
 * `code` is a stable machine string; `message` is human-readable.
 */

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export type ErrorCode =
  | "unauthorized"
  | "not_found"
  | "bad_request"
  | "upstream_error"
  | "internal_error"
  // Integrations (section 40):
  | "not_connected" // action on a provider with no active connection (404)
  | "not_configured" // provider OAuth secrets missing in this environment (501)
  | "provider_error" // upstream provider API failure (502)
  | "reconnect_required"; // refresh token dead / connection flipped to error (409)

export interface ErrorBody {
  error: { code: ErrorCode; message: string };
}

export function errorBody(code: ErrorCode, message: string): ErrorBody {
  return { error: { code, message } };
}

export function errorResponse(
  c: Context,
  status: ContentfulStatusCode,
  code: ErrorCode,
  message: string,
): Response {
  return c.json(errorBody(code, message), status);
}
