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
  | "internal_error";

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
