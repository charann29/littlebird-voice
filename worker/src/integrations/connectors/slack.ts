/**
 * Slack connector (section 40 T4).
 *
 * OAuth v2: `oauth.v2.access` exchange → bot token from `access_token`,
 * `team.id`/`team.name` → account fields. Token rotation is NOT enabled on
 * the Slack app, so the bot token is long-lived: no refreshToken, no
 * expiresAt, no refresh helper (per plan §2 rotation decision).
 *
 * Actions:
 * - `listSlackChannels(token)` → flattened, paginated `conversations.list`
 *   (public channels only, archived excluded).
 * - `postSlackMessage(token, { channelId, text })` → `chat.postMessage`;
 *   Slack's `not_in_channel` error code is surfaced verbatim per plan §2
 *   ("bot can post to a private channel only after being invited").
 *
 * All helpers run server-side only; return types never contain tokens.
 */

import type { Env } from "../../env";
import type { Connector } from "../types";
import {
  type OAuthClientCredentials,
  type TokenSet,
  ConnectorProviderError,
  ValidationError,
  readJsonSafe,
} from "./shared";

export const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
export const SLACK_TOKEN_URL = "https://slack.com/api/oauth.v2.access";
const SLACK_CONVERSATIONS_LIST_URL = "https://slack.com/api/conversations.list";
const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
const SLACK_AUTH_REVOKE_URL = "https://slack.com/api/auth.revoke";

/** Bot scopes: post + channel picker. (No `im:write` — DM sending is not in
 * confirmed scope per plan §2.) */
export const SLACK_BOT_SCOPES = "chat:write,channels:read";

/** chat.postMessage rejects text over 40k chars; stay well below. */
export const SLACK_MAX_TEXT_LENGTH = 40_000;

// ---------------------------------------------------------------------------
// OAuth helpers
// ---------------------------------------------------------------------------

/** Build the Slack consent URL (bot-token install; `scope` = bot scopes). */
export function slackAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(SLACK_AUTHORIZE_URL);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("scope", SLACK_BOT_SCOPES);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("state", params.state);
  return url.toString();
}

interface SlackOAuthResponse {
  ok?: boolean;
  error?: string;
  access_token?: string;
  token_type?: string;
  scope?: string;
  bot_user_id?: string;
  team?: { id?: string; name?: string };
}

/**
 * Exchange the OAuth callback `code` for a TokenSet. Slack returns 200 even
 * on failure and signals errors via `{ ok: false, error }`.
 */
export async function exchangeSlackCode(params: {
  code: string;
  redirectUri: string;
  credentials: OAuthClientCredentials;
}): Promise<TokenSet> {
  const res = await fetch(SLACK_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: params.code,
      client_id: params.credentials.clientId,
      client_secret: params.credentials.clientSecret,
      redirect_uri: params.redirectUri,
    }).toString(),
  });
  const body = (await readJsonSafe(res)) as SlackOAuthResponse | null;
  if (!res.ok || !body || body.ok !== true) {
    const code = body?.error ?? `http_${res.status}`;
    throw new ConnectorProviderError(
      "slack",
      code,
      `Slack oauth.v2.access failed (${code})`,
      res.status,
    );
  }
  if (!body.access_token) {
    throw new ConnectorProviderError("slack", "no_access_token", "Slack returned no access_token");
  }
  return {
    accessToken: body.access_token,
    // Rotation disabled → long-lived bot token, no refresh/expiry.
    tokenType: body.token_type ?? "bot",
    scopes: (body.scope ?? SLACK_BOT_SCOPES).split(",").join(" "),
    externalAccountId: body.team?.id ?? "",
    displayName: body.team?.name ?? "Slack workspace",
    metadata: body.bot_user_id ? { botUserId: body.bot_user_id } : undefined,
  };
}

/** Best-effort token revoke on disconnect. Never throws. */
export async function revokeSlackToken(accessToken: string): Promise<void> {
  try {
    await fetch(SLACK_AUTH_REVOKE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    // Best effort per plan §4 — connection rows are deleted regardless.
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface SlackChannel {
  id: string;
  name: string;
}

interface SlackConversationsListResponse {
  ok?: boolean;
  error?: string;
  channels?: { id?: string; name?: string }[];
  response_metadata?: { next_cursor?: string };
}

/** Guard against a hostile/broken upstream paginating forever. */
const MAX_CHANNEL_PAGES = 20;

/**
 * List public, non-archived channels — paginated upstream, flattened here
 * (per-request only, no caching).
 */
export async function listSlackChannels(
  accessToken: string,
): Promise<{ channels: SlackChannel[] }> {
  const channels: SlackChannel[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_CHANNEL_PAGES; page++) {
    const url = new URL(SLACK_CONVERSATIONS_LIST_URL);
    url.searchParams.set("types", "public_channel");
    url.searchParams.set("exclude_archived", "true");
    url.searchParams.set("limit", "200");
    if (cursor) url.searchParams.set("cursor", cursor);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body = (await readJsonSafe(res)) as SlackConversationsListResponse | null;
    if (!res.ok || !body || body.ok !== true) {
      const code = body?.error ?? `http_${res.status}`;
      throw new ConnectorProviderError(
        "slack",
        code,
        `Slack conversations.list failed (${code})`,
        res.status,
      );
    }
    for (const ch of body.channels ?? []) {
      if (typeof ch.id === "string" && typeof ch.name === "string") {
        channels.push({ id: ch.id, name: ch.name });
      }
    }
    cursor = body.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  return { channels };
}

interface SlackPostMessageResponse {
  ok?: boolean;
  error?: string;
  ts?: string;
}

/**
 * Post a message to a channel. Throws ProviderError with Slack's own error
 * code (e.g. `not_in_channel` when the bot has not been invited to a private
 * channel, `channel_not_found`) so routes can surface it verbatim.
 */
export async function postSlackMessage(
  accessToken: string,
  input: { channelId: string; text: string },
): Promise<{ ok: true; ts: string }> {
  if (typeof input.channelId !== "string" || !input.channelId.trim()) {
    throw new ValidationError("'channelId' must be a non-empty string");
  }
  if (typeof input.text !== "string" || !input.text.trim()) {
    throw new ValidationError("'text' must be a non-empty string");
  }
  if (input.text.length > SLACK_MAX_TEXT_LENGTH) {
    throw new ValidationError(
      `'text' exceeds the ${SLACK_MAX_TEXT_LENGTH}-character Slack limit`,
    );
  }

  const res = await fetch(SLACK_POST_MESSAGE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel: input.channelId, text: input.text }),
  });
  const body = (await readJsonSafe(res)) as SlackPostMessageResponse | null;
  if (!res.ok || !body || body.ok !== true) {
    const code = body?.error ?? `http_${res.status}`;
    const hint =
      code === "not_in_channel"
        ? " — invite the Littlebird bot to the channel and retry"
        : "";
    throw new ConnectorProviderError(
      "slack",
      code,
      `Slack chat.postMessage failed (${code})${hint}`,
      res.status,
    );
  }
  if (typeof body.ts !== "string") {
    throw new ConnectorProviderError("slack", "no_ts", "Slack postMessage returned no ts");
  }
  return { ok: true, ts: body.ts };
}

// ---------------------------------------------------------------------------
// Framework Connector object (registry.ts registers this)
// ---------------------------------------------------------------------------

function slackCredentials(env: Env): OAuthClientCredentials {
  return {
    clientId: env.SLACK_CLIENT_ID ?? "",
    clientSecret: env.SLACK_CLIENT_SECRET ?? "",
  };
}

/** Token rotation is disabled on the Slack app → long-lived bot token, no
 * `refresh` implementation (plan §2). */
export const slackConnector: Connector = {
  slug: "slack",

  isConfigured(env) {
    return Boolean(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET);
  },

  authorizeUrl({ state, redirectUri, env }) {
    return slackAuthorizeUrl({
      clientId: env.SLACK_CLIENT_ID ?? "",
      redirectUri,
      state,
    });
  },

  async exchangeCode({ code, redirectUri, env }) {
    return exchangeSlackCode({
      code,
      redirectUri,
      credentials: slackCredentials(env),
    });
  },

  async revoke(tokenSet) {
    await revokeSlackToken(tokenSet.accessToken);
  },
};
