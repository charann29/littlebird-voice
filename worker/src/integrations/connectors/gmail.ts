/**
 * Gmail connector (section 40 T4).
 *
 * OAuth: shares the single Google OAuth app with the google-calendar
 * connector but requests DIFFERENT scopes (`gmail.send` + `openid email`) and
 * is stored as a separate connection (per-connector consent = scope
 * minimization, per plan §2).
 *
 * Action: `POST /api/integrations/gmail/send` — routes.ts calls
 * `sendGmail(accessToken, input)`; the RFC822 message is built in
 * `buildRfc822Message` (no library): RFC2047 (encoded-word) Subject for
 * non-ASCII, MIME multipart/alternative when `bodyHtml` is present, base64
 * body transfer encoding, CRLF line endings, and an optional
 * `X-Littlebird-Session` header for traceability.
 *
 * All exported helpers run server-side only; return types never contain
 * token material.
 */

import type { Env } from "../../env";
import type { Connector } from "../types";
import {
  type OAuthClientCredentials,
  type TokenSet,
  ConnectorProviderError,
  ValidationError,
  base64Encode,
  base64UrlEncode,
  base64UrlDecodeToString,
  readJsonSafe,
} from "./shared";

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/** Minimal scopes: send-only + account label (no read access). */
export const GMAIL_SCOPES = "https://www.googleapis.com/auth/gmail.send openid email";

const GMAIL_SEND_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

// ---------------------------------------------------------------------------
// OAuth helpers
// ---------------------------------------------------------------------------

/** Build the Google consent URL (offline access → refresh token). */
export function gmailAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GMAIL_SCOPES);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", params.state);
  return url.toString();
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  id_token?: string;
}

/** Decode the (already Google-signed) id_token payload — no verification
 * needed: it arrives over TLS directly from Google's token endpoint. */
function parseIdTokenClaims(idToken: string): { sub?: string; email?: string } {
  const parts = idToken.split(".");
  if (parts.length !== 3) return {};
  try {
    const payload = JSON.parse(base64UrlDecodeToString(parts[1])) as {
      sub?: unknown;
      email?: unknown;
    };
    return {
      sub: typeof payload.sub === "string" ? payload.sub : undefined,
      email: typeof payload.email === "string" ? payload.email : undefined,
    };
  } catch {
    return {};
  }
}

async function googleTokenRequest(
  form: Record<string, string>,
): Promise<GoogleTokenResponse> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const body = await readJsonSafe(res);
  if (!res.ok) {
    const code = typeof body?.error === "string" ? body.error : `http_${res.status}`;
    throw new ConnectorProviderError(
      "gmail",
      code,
      `Google token endpoint returned ${res.status} (${code})`,
      res.status,
    );
  }
  return (body ?? {}) as GoogleTokenResponse;
}

/** Exchange the OAuth callback `code` for a TokenSet (server-side only). */
export async function exchangeGmailCode(params: {
  code: string;
  redirectUri: string;
  credentials: OAuthClientCredentials;
}): Promise<TokenSet> {
  const body = await googleTokenRequest({
    code: params.code,
    client_id: params.credentials.clientId,
    client_secret: params.credentials.clientSecret,
    redirect_uri: params.redirectUri,
    grant_type: "authorization_code",
  });
  if (!body.access_token) {
    throw new ConnectorProviderError("gmail", "no_access_token", "Google returned no access_token");
  }
  const claims = body.id_token ? parseIdTokenClaims(body.id_token) : {};
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt:
      typeof body.expires_in === "number"
        ? Date.now() + body.expires_in * 1000
        : undefined,
    tokenType: body.token_type ?? "Bearer",
    scopes: body.scope ?? GMAIL_SCOPES,
    externalAccountId: claims.sub ?? "",
    displayName: claims.email ?? "Google account",
  };
}

/** Refresh result — routes/store merge this into the stored token row
 * (Google does not rotate the refresh token on refresh). */
export interface GoogleTokenRefresh {
  accessToken: string;
  expiresAt: number;
  tokenType: string;
  scopes: string;
}

/** Refresh an expired Google access token. Throws ProviderError on a dead
 * refresh token (`invalid_grant`) — the store flips status to 'error'. */
export async function refreshGoogleAccessToken(
  refreshToken: string,
  credentials: OAuthClientCredentials,
): Promise<GoogleTokenRefresh> {
  const body = await googleTokenRequest({
    refresh_token: refreshToken,
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    grant_type: "refresh_token",
  });
  if (!body.access_token) {
    throw new ConnectorProviderError("gmail", "no_access_token", "Google refresh returned no access_token");
  }
  return {
    accessToken: body.access_token,
    expiresAt: Date.now() + (typeof body.expires_in === "number" ? body.expires_in : 3600) * 1000,
    tokenType: body.token_type ?? "Bearer",
    scopes: body.scope ?? GMAIL_SCOPES,
  };
}

/** Best-effort revoke (works for access OR refresh tokens). Never throws. */
export async function revokeGoogleToken(token: string): Promise<void> {
  try {
    await fetch(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
  } catch {
    // Best effort per plan §4 — connection rows are deleted regardless.
  }
}

// ---------------------------------------------------------------------------
// RFC822 builder
// ---------------------------------------------------------------------------

export interface GmailSendInput {
  to: string[];
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  /** Stored as an `X-Littlebird-Session` header for traceability only. */
  sessionId?: string;
  /**
   * Optional explicit From address. When omitted the header is left out and
   * Gmail fills in the authenticated account — this is Gmail's documented
   * behavior and avoids fabricating an address for the literal "me".
   */
  from?: string;
}

const CRLF = "\r\n";

/** Header-value injection guard: no CR/LF or other control chars. */
function assertNoControlChars(value: string, field: string): void {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new ValidationError(`${field} must not contain control characters`);
  }
}

function assertValidAddress(addr: string): void {
  assertNoControlChars(addr, "email address");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
    throw new ValidationError(`Invalid email address: ${addr}`);
  }
}

/**
 * RFC2047 encoded-word Subject encoding. ASCII-only subjects pass through
 * unchanged; anything else becomes `=?UTF-8?B?...?=` words folded onto
 * continuation lines, each word ≤ 75 chars (45 raw bytes → 60 base64 chars).
 */
export function encodeRfc2047(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const encoder = new TextEncoder();
  const words: string[] = [];
  let chunkBytes: number[] = [];
  for (const ch of value) {
    const bytes = encoder.encode(ch);
    if (chunkBytes.length + bytes.length > 45) {
      words.push(`=?UTF-8?B?${base64Encode(Uint8Array.from(chunkBytes))}?=`);
      chunkBytes = [];
    }
    chunkBytes.push(...bytes);
  }
  if (chunkBytes.length > 0) {
    words.push(`=?UTF-8?B?${base64Encode(Uint8Array.from(chunkBytes))}?=`);
  }
  // Adjacent encoded words are separated by folding whitespace (CRLF + SP).
  return words.join(`${CRLF} `);
}

/** base64 with RFC 2045 76-char line wrapping (for body parts). */
function base64Mime(text: string): string {
  const b64 = base64Encode(text);
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join(CRLF);
}

function textPart(contentType: string, content: string): string {
  return [
    `Content-Type: ${contentType}; charset="UTF-8"`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Mime(content),
  ].join(CRLF);
}

/**
 * Build the full RFC822 message (CRLF line endings). `boundary` is injectable
 * for deterministic tests; defaults to a random one.
 */
export function buildRfc822Message(
  input: GmailSendInput,
  opts: { boundary?: string } = {},
): string {
  if (!Array.isArray(input.to) || input.to.length === 0) {
    throw new ValidationError("'to' must be a non-empty array of email addresses");
  }
  for (const addr of input.to) assertValidAddress(addr);
  if (typeof input.subject !== "string") {
    throw new ValidationError("'subject' must be a string");
  }
  assertNoControlChars(input.subject, "subject");
  if (typeof input.bodyText !== "string" || input.bodyText.length === 0) {
    throw new ValidationError("'bodyText' must be a non-empty string");
  }
  if (input.from !== undefined) assertValidAddress(input.from);
  if (input.sessionId !== undefined) {
    assertNoControlChars(input.sessionId, "sessionId");
  }

  const headers: string[] = [];
  if (input.from) headers.push(`From: ${input.from}`);
  headers.push(`To: ${input.to.join(", ")}`);
  headers.push(`Subject: ${encodeRfc2047(input.subject)}`);
  if (input.sessionId) headers.push(`X-Littlebird-Session: ${input.sessionId}`);
  headers.push("MIME-Version: 1.0");

  if (input.bodyHtml === undefined) {
    return [
      ...headers,
      `Content-Type: text/plain; charset="UTF-8"`,
      "Content-Transfer-Encoding: base64",
      "",
      base64Mime(input.bodyText),
    ].join(CRLF);
  }

  const boundary =
    opts.boundary ?? `littlebird_${crypto.randomUUID().replace(/-/g, "")}`;
  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    textPart("text/plain", input.bodyText),
    `--${boundary}`,
    textPart("text/html", input.bodyHtml),
    `--${boundary}--`,
    "",
  ].join(CRLF);
}

// ---------------------------------------------------------------------------
// Send action
// ---------------------------------------------------------------------------

/**
 * Send an email via the Gmail API. `accessToken` is a decrypted plaintext
 * token obtained by the caller (routes → store.getAccessToken); it never
 * appears in the return value.
 */
export async function sendGmail(
  accessToken: string,
  input: GmailSendInput,
): Promise<{ messageId: string }> {
  const raw = base64UrlEncode(buildRfc822Message(input));
  const res = await fetch(GMAIL_SEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });
  const body = await readJsonSafe(res);
  if (!res.ok) {
    const upstream = body?.error as { status?: unknown } | undefined;
    const code =
      typeof upstream?.status === "string" ? upstream.status : `http_${res.status}`;
    throw new ConnectorProviderError(
      "gmail",
      code,
      `Gmail send failed with ${res.status} (${code})`,
      res.status,
    );
  }
  const messageId = typeof body?.id === "string" ? body.id : "";
  if (!messageId) {
    throw new ConnectorProviderError("gmail", "no_message_id", "Gmail send returned no message id");
  }
  return { messageId };
}

// ---------------------------------------------------------------------------
// Framework Connector object (registry.ts registers this)
// ---------------------------------------------------------------------------

function googleCredentials(env: Env): OAuthClientCredentials {
  return {
    clientId: env.GOOGLE_OAUTH_CLIENT_ID ?? "",
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
  };
}

/** Shares the Google OAuth app with google-calendar (separate consent,
 * gmail.send scope only, separate connection row). */
export const gmailConnector: Connector = {
  slug: "gmail",

  isConfigured(env) {
    return Boolean(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET);
  },

  authorizeUrl({ state, redirectUri, env }) {
    return gmailAuthorizeUrl({
      clientId: env.GOOGLE_OAUTH_CLIENT_ID ?? "",
      redirectUri,
      state,
    });
  },

  async exchangeCode({ code, redirectUri, env }) {
    return exchangeGmailCode({
      code,
      redirectUri,
      credentials: googleCredentials(env),
    });
  },

  async refresh(refreshToken, env) {
    const refreshed = await refreshGoogleAccessToken(
      refreshToken,
      googleCredentials(env),
    );
    // Google refresh responses omit account identity claims; store keeps the
    // existing connection row and only persists the rotated token fields.
    return {
      accessToken: refreshed.accessToken,
      expiresAt: refreshed.expiresAt,
      tokenType: refreshed.tokenType,
      scopes: refreshed.scopes,
      externalAccountId: "",
      displayName: "",
    };
  },

  async revoke(tokenSet) {
    // Revoking either token invalidates the whole grant; refresh preferred.
    await revokeGoogleToken(tokenSet.refreshToken ?? tokenSet.accessToken);
  },
};
