/**
 * Shared primitives for the provider connector modules (gmail / slack /
 * notion — section 40 T4).
 *
 * Design rules (enforced across all three connectors):
 * - OAuth helpers return the framework `TokenSet` (types.ts) for the
 *   routes/store layer to encrypt and persist; they are only ever called
 *   server-side.
 * - Action helpers take a PLAIN access token string (routes call
 *   `getAccessToken(...)` first) and return browser-safe payloads: no return
 *   type in this directory ever contains token material.
 * - Upstream failures throw `ConnectorProviderError` — a subclass of the
 *   framework `ProviderError`, so routes.ts's existing
 *   `err instanceof ProviderError` → 502 `provider_error` mapping applies —
 *   carrying a stable short `code` (the provider's own error code when it has
 *   one, e.g. Slack `not_in_channel`, else `http_<status>`). Caller-input
 *   problems throw `ValidationError` (→ 400 `bad_request`).
 */

import { ProviderError } from "../types";

/** Re-exported so connector modules/tests have a single import point. */
export type { TokenSet } from "../types";

/** OAuth app credentials — read from Worker secrets by the connector objects. */
export interface OAuthClientCredentials {
  clientId: string;
  clientSecret: string;
}

export type ConnectorSlug = "gmail" | "slack" | "notion";

/**
 * Upstream provider failure with a machine-stable short code. Subclasses the
 * framework ProviderError so the routes' 502 mapping catches it; the message
 * always embeds `code` so it survives the `{ error: { code:
 * "provider_error", message } }` serialization without leaking bodies.
 */
export class ConnectorProviderError extends ProviderError {
  readonly provider: ConnectorSlug;
  readonly code: string;

  constructor(provider: ConnectorSlug, code: string, message: string, status?: number) {
    super(message, status);
    this.name = "ProviderError";
    this.provider = provider;
    this.code = code;
  }
}

/** Bad caller input (routes map to 400 `bad_request`). */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** UTF-8 string (or raw bytes) → standard base64. */
export function base64Encode(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** UTF-8 string (or raw bytes) → base64url without padding (RFC 4648 §5). */
export function base64UrlEncode(input: string | Uint8Array): string {
  return base64Encode(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url → UTF-8 string (id_token payload decoding). */
export function base64UrlDecodeToString(b64url: string): string {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Parse a response body as JSON, returning null on any failure. */
export async function readJsonSafe(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body = (await res.json()) as unknown;
    if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Split on Unicode code points into pieces of at most `max` code units. */
export function splitTextChunks(text: string, max: number): string[] {
  if (text.length <= max) return text.length > 0 ? [text] : [];
  const chunks: string[] = [];
  let current = "";
  for (const ch of text) {
    if (current.length + ch.length > max) {
      chunks.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
