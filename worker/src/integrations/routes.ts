/**
 * Integrations HTTP routes (section 40).
 *
 * Two exports with different auth semantics:
 *  - `integrationsCallbackRoutes` — the OAuth callback ONLY. It is a browser
 *    navigation carrying no Authorization header, so index.ts mounts it
 *    BEFORE the auth middleware. The user identity comes from the signed,
 *    single-use state row — never from the request.
 *  - `integrationsRoutes` — everything else (list/connect/disconnect +
 *    per-connector actions), mounted after auth like every other route file.
 *
 * Error semantics per plan §4: 404 not_connected, 501 not_configured,
 * 502 provider_error, 409 reconnect_required.
 */

import { Hono, type Context } from "hono";
import type { Env } from "../env";
import type { AuthVariables } from "../auth";
import { errorResponse } from "../errors";
import {
  isProviderSlug,
  ProviderError,
  ReconnectRequiredError,
  type ConnectionRow,
  type ProviderSlug,
  PROVIDER_SLUGS,
} from "./types";
import { generateStateId, signState, verifyState } from "./crypto";
import {
  consumeOauthState,
  createOauthState,
  deleteConnection,
  getAccessToken,
  getConnection,
  listConnections,
  upsertConnection,
} from "./store";
import { getConnector } from "./registry";
import { listUpcomingEvents } from "./connectors/googleCalendar";

type App = { Bindings: Env; Variables: AuthVariables };

const DEFAULT_APP_BASE_URL = "http://localhost:5173";
const DEFAULT_WORKER_BASE_URL = "http://localhost:8787";
const DEFAULT_RETURN_PATH = "/settings/connections";

export function appBaseUrl(env: Env): string {
  return (env.APP_BASE_URL ?? DEFAULT_APP_BASE_URL).replace(/\/$/, "");
}

export function workerBaseUrl(env: Env): string {
  return (env.WORKER_BASE_URL ?? DEFAULT_WORKER_BASE_URL).replace(/\/$/, "");
}

export function callbackRedirectUri(env: Env, provider: ProviderSlug): string {
  return `${workerBaseUrl(env)}/api/integrations/${provider}/callback`;
}

/** Only same-app paths are allowed as post-callback redirect targets. */
function sanitizeRedirectTo(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  if (!raw.startsWith("/") || raw.startsWith("//")) return undefined;
  return raw;
}

function parseProvider(raw: string): ProviderSlug | null {
  return isProviderSlug(raw) ? raw : null;
}

async function readJson(c: {
  req: { json: () => Promise<unknown> };
}): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return null;
    }
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Look up an active connection or produce the canonical error response. */
async function requireActiveConnection(
  c: Context<App>,
  provider: ProviderSlug,
): Promise<ConnectionRow | Response> {
  const conn = await getConnection(c.env, c.var.userId, provider);
  if (!conn) {
    return errorResponse(c, 404, "not_connected", `${provider} is not connected`);
  }
  if (conn.status !== "active") {
    return errorResponse(
      c,
      409,
      "reconnect_required",
      `${provider} connection needs to be re-authorized`,
    );
  }
  return conn;
}

// ---------------------------------------------------------------------------
// Unauthenticated callback (mounted BEFORE auth middleware in index.ts)
// ---------------------------------------------------------------------------

export const integrationsCallbackRoutes = new Hono<{ Bindings: Env }>().get(
  "/integrations/:provider/callback",
  async (c) => {
    const env = c.env;
    const providerRaw = c.req.param("provider");
    const provider = parseProvider(providerRaw);

    // Redirect helper — short error codes only; provider error bodies never
    // leak into the browser URL.
    const back = (params: Record<string, string>, redirectTo?: string | null) => {
      const target = new URL(
        `${appBaseUrl(env)}${redirectTo ?? DEFAULT_RETURN_PATH}`,
      );
      for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
      return c.redirect(target.toString(), 302);
    };

    if (!provider) return back({ error: "unknown_provider" });

    const state = c.req.query("state") ?? "";
    const code = c.req.query("code") ?? "";
    const signingKey = env.OAUTH_STATE_SIGNING_KEY;
    if (!signingKey || !env.INTEGRATIONS_TOKEN_KEY) {
      return back({ error: "not_configured" });
    }

    // 1. Signature check — forged states never reach the DB.
    const stateId = state ? await verifyState(state, signingKey) : null;
    if (!stateId) {
      return c.json(
        { error: { code: "bad_request", message: "Invalid or missing state" } },
        400,
      );
    }
    // 2. Single-use consume (unexpired, unused → mark used atomically).
    const consumed = await consumeOauthState(env, stateId);
    if (!consumed || consumed.provider !== provider) {
      return c.json(
        { error: { code: "bad_request", message: "Expired, replayed, or mismatched state" } },
        400,
      );
    }

    // Connector lookup happens after state validation so forged/mismatched
    // states are always 400 regardless of registry contents.
    const connector = getConnector(provider);
    if (!connector) return back({ error: "unknown_provider" }, consumed.redirectTo);

    // Provider sent the user back with an error (e.g. consent denied).
    const providerError = c.req.query("error");
    if (providerError || !code) {
      return back({ error: "access_denied" }, consumed.redirectTo);
    }

    try {
      const tokens = await connector.exchangeCode({
        code,
        redirectUri: callbackRedirectUri(env, provider),
        env,
      });
      await upsertConnection(env, consumed.userId, provider, tokens);
      return back({ connected: provider }, consumed.redirectTo);
    } catch (err) {
      console.error(`OAuth exchange failed for ${provider}:`, err);
      return back({ error: "exchange_failed" }, consumed.redirectTo);
    }
  },
);

// ---------------------------------------------------------------------------
// Authenticated framework + action routes
// ---------------------------------------------------------------------------

export const integrationsRoutes = new Hono<App>()

  // GET /integrations — all 4 providers, connected or not. Never includes
  // token material (tokens live in a table this query cannot touch).
  .get("/integrations", async (c) => {
    const rows = await listConnections(c.env, c.var.userId);
    const bySlug = new Map(rows.map((r) => [r.provider, r]));
    const providers = PROVIDER_SLUGS.map((slug) => {
      const row = bySlug.get(slug);
      if (!row) {
        return { provider: slug, connected: false as const };
      }
      return {
        provider: slug,
        connected: true as const,
        status: row.status,
        displayName: row.display_name,
        scopes: row.scopes,
        connectedAt: row.created_at,
      };
    });
    return c.json({ providers });
  })

  // POST /integrations/:provider/connect → { authorizeUrl }
  .post("/integrations/:provider/connect", async (c) => {
    const provider = parseProvider(c.req.param("provider"));
    if (!provider) {
      return errorResponse(c, 404, "not_found", "Unknown provider");
    }
    const connector = getConnector(provider);
    if (!connector || !connector.isConfigured(c.env)) {
      return errorResponse(
        c,
        501,
        "not_configured",
        `${provider} OAuth credentials are not configured on this Worker`,
      );
    }
    if (!c.env.OAUTH_STATE_SIGNING_KEY || !c.env.INTEGRATIONS_TOKEN_KEY) {
      return errorResponse(
        c,
        501,
        "not_configured",
        "OAUTH_STATE_SIGNING_KEY / INTEGRATIONS_TOKEN_KEY secrets are not set",
      );
    }

    const body = (await readJson(c)) ?? {};
    const redirectTo = sanitizeRedirectTo(body.redirectTo);

    const stateId = generateStateId();
    await createOauthState(c.env, {
      stateId,
      userId: c.var.userId,
      provider,
      redirectTo,
    });
    const state = await signState(stateId, c.env.OAUTH_STATE_SIGNING_KEY);
    const authorizeUrl = connector.authorizeUrl({
      state,
      redirectUri: callbackRedirectUri(c.env, provider),
      env: c.env,
    });
    return c.json({ authorizeUrl });
  })

  // DELETE /integrations/:provider — best-effort revoke, delete rows.
  .delete("/integrations/:provider", async (c) => {
    const provider = parseProvider(c.req.param("provider"));
    if (!provider) {
      return errorResponse(c, 404, "not_found", "Unknown provider");
    }
    const conn = await getConnection(c.env, c.var.userId, provider);
    if (!conn) {
      return errorResponse(c, 404, "not_connected", `${provider} is not connected`);
    }
    const tokens = await deleteConnection(c.env, conn);
    const connector = getConnector(provider);
    if (tokens && connector?.revoke) {
      try {
        await connector.revoke(tokens, c.env);
      } catch {
        // Best effort — rows are already gone.
      }
    }
    return c.json({ ok: true });
  })

  // GET /integrations/google-calendar/events?days=7 — normalized upcoming
  // events for the prep list.
  .get("/integrations/google-calendar/events", async (c) => {
    const daysRaw = Number(c.req.query("days") ?? "7");
    const days = Number.isFinite(daysRaw)
      ? Math.min(Math.max(Math.trunc(daysRaw), 1), 31)
      : 7;

    const connOrRes = await requireActiveConnection(c, "google-calendar");
    if (connOrRes instanceof Response) return connOrRes;
    const connector = getConnector("google-calendar");
    if (!connector) {
      return errorResponse(c, 501, "not_configured", "google-calendar not registered");
    }

    try {
      const accessToken = await getAccessToken(c.env, connOrRes, connector);
      const events = await listUpcomingEvents(
        accessToken,
        days * 24 * 60 * 60 * 1000,
      );
      return c.json({ events });
    } catch (err) {
      if (err instanceof ReconnectRequiredError) {
        return errorResponse(
          c,
          409,
          "reconnect_required",
          "Google Calendar connection needs to be re-authorized",
        );
      }
      if (err instanceof ProviderError) {
        return errorResponse(c, 502, "provider_error", err.message);
      }
      throw err;
    }
  });
