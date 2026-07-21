/**
 * D1 access layer for integrations (section 40).
 *
 * Connections and token ciphertext live in separate tables so listing
 * connections never touches ciphertext columns. `getAccessToken` is the only
 * place plaintext access tokens materialize — it decrypts, transparently
 * refreshes expiring Google tokens (persisting rotated tokens), and flips the
 * connection to status='error' when the refresh token is dead.
 */

import type { Env } from "../env";
import {
  ReconnectRequiredError,
  type ConnectionRow,
  type Connector,
  type ProviderSlug,
  type TokenSet,
} from "./types";
import { decryptToken, encryptToken } from "./crypto";

/** Refresh when the token expires within this many ms. */
const REFRESH_SKEW_MS = 60_000;

const CONNECTION_COLUMNS =
  "id, user_id, provider, external_account_id, display_name, scopes, status, metadata, created_at, updated_at";

function requireTokenKey(env: Env): string {
  const key = env.INTEGRATIONS_TOKEN_KEY;
  if (!key) {
    throw new Error(
      "INTEGRATIONS_TOKEN_KEY is not configured — cannot handle provider tokens",
    );
  }
  return key;
}

export async function getConnection(
  env: Env,
  userId: string,
  provider: ProviderSlug,
): Promise<ConnectionRow | null> {
  const row = await env.DB.prepare(
    `SELECT ${CONNECTION_COLUMNS} FROM integration_connections
     WHERE user_id = ? AND provider = ?`,
  )
    .bind(userId, provider)
    .first<ConnectionRow>();
  return row ?? null;
}

export async function listConnections(
  env: Env,
  userId: string,
): Promise<ConnectionRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${CONNECTION_COLUMNS} FROM integration_connections WHERE user_id = ?`,
  )
    .bind(userId)
    .all<ConnectionRow>();
  return results;
}

/** Upsert connection + tokens after a successful code exchange. Returns the
 *  connection id. One connection per (user, provider) — reconnecting replaces
 *  the account/tokens and resets status to 'active'. */
export async function upsertConnection(
  env: Env,
  userId: string,
  provider: ProviderSlug,
  tokens: TokenSet,
): Promise<string> {
  const keyB64 = requireTokenKey(env);
  const now = Date.now();
  const existing = await getConnection(env, userId, provider);
  const id = existing?.id ?? crypto.randomUUID();

  const accessEnc = await encryptToken(tokens.accessToken, keyB64);
  const refreshEnc = tokens.refreshToken
    ? await encryptToken(tokens.refreshToken, keyB64)
    : null;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO integration_connections
         (id, user_id, provider, external_account_id, display_name, scopes,
          status, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
       ON CONFLICT (user_id, provider) DO UPDATE SET
         external_account_id = excluded.external_account_id,
         display_name = excluded.display_name,
         scopes = excluded.scopes,
         status = 'active',
         metadata = excluded.metadata,
         updated_at = excluded.updated_at`,
    ).bind(
      id,
      userId,
      provider,
      tokens.externalAccountId,
      tokens.displayName,
      tokens.scopes,
      tokens.metadata ? JSON.stringify(tokens.metadata) : null,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO integration_tokens
         (connection_id, access_token_enc, refresh_token_enc, token_type, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (connection_id) DO UPDATE SET
         access_token_enc = excluded.access_token_enc,
         refresh_token_enc = excluded.refresh_token_enc,
         token_type = excluded.token_type,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
    ).bind(
      id,
      accessEnc,
      refreshEnc,
      tokens.tokenType || "Bearer",
      tokens.expiresAt ?? null,
      now,
    ),
  ]);
  return id;
}

/** Delete a connection (token row cascades). Returns the decrypted tokens for
 *  best-effort revocation, or null when no token row existed. */
export async function deleteConnection(
  env: Env,
  connection: ConnectionRow,
): Promise<{ accessToken: string; refreshToken?: string } | null> {
  let tokens: { accessToken: string; refreshToken?: string } | null = null;
  const row = await env.DB.prepare(
    `SELECT access_token_enc, refresh_token_enc FROM integration_tokens
     WHERE connection_id = ?`,
  )
    .bind(connection.id)
    .first<{ access_token_enc: string; refresh_token_enc: string | null }>();
  if (row && env.INTEGRATIONS_TOKEN_KEY) {
    try {
      tokens = {
        accessToken: await decryptToken(
          row.access_token_enc,
          env.INTEGRATIONS_TOKEN_KEY,
        ),
        refreshToken: row.refresh_token_enc
          ? await decryptToken(row.refresh_token_enc, env.INTEGRATIONS_TOKEN_KEY)
          : undefined,
      };
    } catch {
      tokens = null; // undecryptable rows still get deleted
    }
  }
  await env.DB.prepare("DELETE FROM integration_connections WHERE id = ?")
    .bind(connection.id)
    .run();
  return tokens;
}

async function markConnectionError(env: Env, connectionId: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE integration_connections SET status = 'error', updated_at = ? WHERE id = ?",
  )
    .bind(Date.now(), connectionId)
    .run();
}

/**
 * Decrypt (and if necessary refresh) the access token for a connection.
 * The returned plaintext must never be persisted or serialized to a client.
 *
 * Throws `ReconnectRequiredError` when the refresh token is missing/dead —
 * the connection has already been flipped to status='error' by then.
 */
export async function getAccessToken(
  env: Env,
  connection: ConnectionRow,
  connector: Connector,
): Promise<string> {
  const keyB64 = requireTokenKey(env);
  const row = await env.DB.prepare(
    `SELECT access_token_enc, refresh_token_enc, expires_at FROM integration_tokens
     WHERE connection_id = ?`,
  )
    .bind(connection.id)
    .first<{
      access_token_enc: string;
      refresh_token_enc: string | null;
      expires_at: number | null;
    }>();
  if (!row) {
    await markConnectionError(env, connection.id);
    throw new ReconnectRequiredError(connection.provider);
  }

  const expiring =
    row.expires_at !== null && row.expires_at < Date.now() + REFRESH_SKEW_MS;
  if (!expiring) {
    return decryptToken(row.access_token_enc, keyB64);
  }

  // Token is expired/expiring: refresh (Google only in practice).
  if (!row.refresh_token_enc || !connector.refresh) {
    await markConnectionError(env, connection.id);
    throw new ReconnectRequiredError(connection.provider);
  }
  const refreshToken = await decryptToken(row.refresh_token_enc, keyB64);
  let refreshed: TokenSet;
  try {
    refreshed = await connector.refresh(refreshToken, env);
  } catch {
    await markConnectionError(env, connection.id);
    throw new ReconnectRequiredError(connection.provider);
  }

  // Persist rotated tokens (Google may or may not return a new refresh token;
  // keep the old one when it doesn't).
  const now = Date.now();
  const accessEnc = await encryptToken(refreshed.accessToken, keyB64);
  const refreshEnc = refreshed.refreshToken
    ? await encryptToken(refreshed.refreshToken, keyB64)
    : row.refresh_token_enc;
  await env.DB.prepare(
    `UPDATE integration_tokens
     SET access_token_enc = ?, refresh_token_enc = ?, expires_at = ?, updated_at = ?
     WHERE connection_id = ?`,
  )
    .bind(accessEnc, refreshEnc, refreshed.expiresAt ?? null, now, connection.id)
    .run();
  return refreshed.accessToken;
}

// ---------------------------------------------------------------------------
// OAuth state rows
// ---------------------------------------------------------------------------

const STATE_TTL_MS = 10 * 60 * 1000;

export async function createOauthState(
  env: Env,
  params: {
    stateId: string;
    userId: string;
    provider: ProviderSlug;
    redirectTo?: string;
  },
): Promise<void> {
  const now = Date.now();
  // Opportunistic cleanup of long-expired rows (index on expires_at).
  await env.DB.batch([
    env.DB.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(
      now - STATE_TTL_MS,
    ),
    env.DB.prepare(
      `INSERT INTO oauth_states (state_id, user_id, provider, redirect_to, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      params.stateId,
      params.userId,
      params.provider,
      params.redirectTo ?? null,
      now,
      now + STATE_TTL_MS,
    ),
  ]);
}

export interface ConsumedState {
  userId: string;
  provider: string;
  redirectTo: string | null;
}

/** Atomically consume a state row: single-use enforced by the conditional
 *  UPDATE (`used_at IS NULL`) — a replayed state returns null. */
export async function consumeOauthState(
  env: Env,
  stateId: string,
): Promise<ConsumedState | null> {
  const now = Date.now();
  const marked = await env.DB.prepare(
    `UPDATE oauth_states SET used_at = ?
     WHERE state_id = ? AND used_at IS NULL AND expires_at >= ?`,
  )
    .bind(now, stateId, now)
    .run();
  if (marked.meta.changes !== 1) return null;
  const row = await env.DB.prepare(
    "SELECT user_id, provider, redirect_to FROM oauth_states WHERE state_id = ?",
  )
    .bind(stateId)
    .first<{ user_id: string; provider: string; redirect_to: string | null }>();
  if (!row) return null;
  return {
    userId: row.user_id,
    provider: row.provider,
    redirectTo: row.redirect_to,
  };
}
