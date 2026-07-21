/**
 * Integrations framework contracts (section 40, Track B).
 *
 * A `Connector` implements one provider's OAuth dance; tokens are stored
 * AES-GCM-encrypted in D1 (see store.ts) and never serialized to the client.
 */

import type { Env } from "../env";

export const PROVIDER_SLUGS = [
  "google-calendar",
  "gmail",
  "slack",
  "notion",
] as const;

export type ProviderSlug = (typeof PROVIDER_SLUGS)[number];

export function isProviderSlug(value: string): value is ProviderSlug {
  return (PROVIDER_SLUGS as readonly string[]).includes(value);
}

/** Result of a code exchange / refresh. Plaintext tokens live only in Worker
 *  memory for the duration of a request. */
export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms; undefined = non-expiring (Slack bot token, Notion). */
  expiresAt?: number;
  tokenType: string;
  /** Space-separated granted scopes ('' for Notion). */
  scopes: string;
  /** Google sub / Slack team_id / Notion workspace_id. */
  externalAccountId: string;
  /** Email / workspace name shown in the Connections UI. */
  displayName: string;
  /** Provider-specific extras persisted as JSON on the connection row. */
  metadata?: Record<string, unknown>;
}

export interface Connector {
  slug: ProviderSlug;
  /** True when all OAuth secrets for this provider exist in `env`. Local dev
   *  without credentials keeps every other route usable; Connect returns
   *  501 not_configured. */
  isConfigured(env: Env): boolean;
  authorizeUrl(params: { state: string; redirectUri: string; env: Env }): string;
  exchangeCode(params: {
    code: string;
    redirectUri: string;
    env: Env;
  }): Promise<TokenSet>;
  /** Present only for providers with expiring tokens (Google). */
  refresh?(refreshToken: string, env: Env): Promise<TokenSet>;
  /** Best-effort revocation on disconnect. */
  revoke?(tokenSet: { accessToken: string; refreshToken?: string }, env: Env): Promise<void>;
}

/** Connection row shape as read from D1 (no token material). */
export interface ConnectionRow {
  id: string;
  user_id: string;
  provider: string;
  external_account_id: string;
  display_name: string;
  scopes: string;
  status: "active" | "error" | "revoked";
  metadata: string | null;
  created_at: number;
  updated_at: number;
}

/** Error thrown by connectors / store on upstream provider failures. Carries
 *  a short code only — provider response bodies never leak into client URLs
 *  or error messages verbatim. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Thrown by getAccessToken when the refresh token is dead; the connection
 *  has already been flipped to status='error'. */
export class ReconnectRequiredError extends Error {
  constructor(readonly provider: string) {
    super(`Connection to ${provider} needs to be re-authorized`);
    this.name = "ReconnectRequiredError";
  }
}
