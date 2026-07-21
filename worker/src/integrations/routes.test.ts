import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { api } from "../../test/helpers";
import type { Env } from "../env";
import { SINGLE_USER_ID } from "../auth";
import { signState, generateStateId } from "./crypto";
import { createOauthState, getConnection, upsertConnection } from "./store";
import type { TokenSet } from "./types";

const testEnv = env as unknown as Env;

/** Stub global fetch for upstream provider calls (worker-internal requests
 *  go through worker.fetch directly, same pattern as soniox.test.ts). */
type FetchArgs = { url: string; init: RequestInit & { headers: Headers } };
let upstreamCalls: FetchArgs[];
let upstreamResponder: (args: FetchArgs) => Response | Promise<Response>;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  upstreamCalls = [];
  upstreamResponder = () => {
    throw new Error("unexpected upstream fetch");
  };
  // Storage is shared within a test file — reset the tables this suite touches.
  await testEnv.DB.batch([
    testEnv.DB.prepare("DELETE FROM integration_connections"),
    testEnv.DB.prepare("DELETE FROM oauth_states"),
  ]);
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      const args: FetchArgs = { url, init: { ...init, headers } };
      upstreamCalls.push(args);
      return upstreamResponder(args);
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.fetch = realFetch;
});

function connectedTokens(overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken: "cal-access",
    refreshToken: "cal-refresh",
    expiresAt: Date.now() + 3600_000,
    tokenType: "Bearer",
    scopes: "https://www.googleapis.com/auth/calendar.events.readonly openid email",
    externalAccountId: "sub-123",
    displayName: "user@example.com",
    ...overrides,
  };
}

async function signedStateFor(
  provider: "google-calendar",
  redirectTo?: string,
): Promise<string> {
  const stateId = generateStateId();
  await createOauthState(testEnv, {
    stateId,
    userId: SINGLE_USER_ID,
    provider,
    redirectTo,
  });
  return signState(stateId, testEnv.OAUTH_STATE_SIGNING_KEY!);
}

describe("GET /api/integrations", () => {
  it("requires auth", async () => {
    const res = await api("/api/integrations", { token: null, env: testEnv });
    expect(res.status).toBe(401);
  });

  it("lists all providers with connection status and NO token material", async () => {
    await upsertConnection(
      testEnv,
      SINGLE_USER_ID,
      "google-calendar",
      connectedTokens(),
    );
    const res = await api("/api/integrations", { env: testEnv });
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as {
      providers: { provider: string; connected: boolean; displayName?: string }[];
    };
    expect(body.providers.map((p) => p.provider).sort()).toEqual(
      ["gmail", "google-calendar", "notion", "slack"].sort(),
    );
    const cal = body.providers.find((p) => p.provider === "google-calendar")!;
    expect(cal.connected).toBe(true);
    expect(cal.displayName).toBe("user@example.com");
    // No token material anywhere in the response.
    expect(text.toLowerCase()).not.toContain("token");
    expect(text).not.toContain("cal-access");
    expect(text).not.toContain("cal-refresh");
  });
});

describe("POST /api/integrations/:provider/connect", () => {
  it("returns a Google authorize URL with signed state + registered redirect_uri", async () => {
    const res = await api("/api/integrations/google-calendar/connect", {
      method: "POST",
      body: { redirectTo: "/settings/connections" },
      env: testEnv,
    });
    expect(res.status).toBe(200);
    const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
    const url = new URL(authorizeUrl);
    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(url.searchParams.get("client_id")).toBe("test-google-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://worker.example.com/api/integrations/google-calendar/callback",
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    const state = url.searchParams.get("state")!;
    expect(state).toMatch(/^[0-9a-f]{64}\.[0-9a-f]{64}$/);
    // State row exists.
    const row = await testEnv.DB.prepare(
      "SELECT user_id, provider FROM oauth_states WHERE state_id = ?",
    )
      .bind(state.split(".")[0])
      .first<{ user_id: string; provider: string }>();
    expect(row).toEqual({
      user_id: SINGLE_USER_ID,
      provider: "google-calendar",
    });
  });

  it("404s unknown providers and 501s unregistered ones", async () => {
    const unknown = await api("/api/integrations/dropbox/connect", {
      method: "POST",
      env: testEnv,
    });
    expect(unknown.status).toBe(404);
    // gmail is a valid slug but not registered by this section (T4 adds it).
    const unregistered = await api("/api/integrations/gmail/connect", {
      method: "POST",
      env: testEnv,
    });
    expect(unregistered.status).toBe(501);
    const body = (await unregistered.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_configured");
  });

  it("requires auth", async () => {
    const res = await api("/api/integrations/google-calendar/connect", {
      method: "POST",
      token: null,
      env: testEnv,
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/integrations/:provider/callback (unauthenticated)", () => {
  it("exchanges the code, stores the connection, and redirects with ?connected=", async () => {
    upstreamResponder = async ({ url, init }) => {
      expect(url).toBe("https://oauth2.googleapis.com/token");
      const params = new URLSearchParams(String(init.body));
      expect(params.get("code")).toBe("auth-code-1");
      expect(params.get("grant_type")).toBe("authorization_code");
      expect(params.get("redirect_uri")).toBe(
        "https://worker.example.com/api/integrations/google-calendar/callback",
      );
      // id_token payload: { sub: "sub-9", email: "cb@example.com" }
      const payload = btoa(
        JSON.stringify({ sub: "sub-9", email: "cb@example.com" }),
      )
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      return Response.json({
        access_token: "cb-access",
        refresh_token: "cb-refresh",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "openid email https://www.googleapis.com/auth/calendar.events.readonly",
        id_token: `h.${payload}.s`,
      });
    };

    const state = await signedStateFor("google-calendar", "/after");
    const res = await api(
      `/api/integrations/google-calendar/callback?code=auth-code-1&state=${encodeURIComponent(state)}`,
      { token: null, env: testEnv },
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location")!);
    expect(location.origin).toBe("https://app.example.com");
    expect(location.pathname).toBe("/after");
    expect(location.searchParams.get("connected")).toBe("google-calendar");

    const conn = await getConnection(testEnv, SINGLE_USER_ID, "google-calendar");
    expect(conn).not.toBeNull();
    expect(conn!.display_name).toBe("cb@example.com");
    expect(conn!.external_account_id).toBe("sub-9");
    expect(conn!.status).toBe("active");
  });

  it("rejects a forged state with 400 before touching the DB or provider", async () => {
    const forged = `${generateStateId()}.${"0".repeat(64)}`;
    const res = await api(
      `/api/integrations/google-calendar/callback?code=x&state=${forged}`,
      { token: null, env: testEnv },
    );
    expect(res.status).toBe(400);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("rejects a replayed state with 400 (single-use)", async () => {
    upstreamResponder = async () =>
      Response.json({
        access_token: "a",
        expires_in: 3600,
        token_type: "Bearer",
      });
    const state = await signedStateFor("google-calendar");
    const first = await api(
      `/api/integrations/google-calendar/callback?code=c1&state=${encodeURIComponent(state)}`,
      { token: null, env: testEnv },
    );
    expect(first.status).toBe(302);
    const replay = await api(
      `/api/integrations/google-calendar/callback?code=c1&state=${encodeURIComponent(state)}`,
      { token: null, env: testEnv },
    );
    expect(replay.status).toBe(400);
    expect(upstreamCalls).toHaveLength(1); // only the first exchange
  });

  it("rejects a state issued for a different provider", async () => {
    const state = await signedStateFor("google-calendar");
    const res = await api(
      `/api/integrations/gmail/callback?code=c&state=${encodeURIComponent(state)}`,
      { token: null, env: testEnv },
    );
    expect(res.status).toBe(400);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("redirects with a short error code when the user denied consent", async () => {
    const state = await signedStateFor("google-calendar");
    const res = await api(
      `/api/integrations/google-calendar/callback?error=access_denied&state=${encodeURIComponent(state)}`,
      { token: null, env: testEnv },
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location")!);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(upstreamCalls).toHaveLength(0);
  });

  it("redirects with error=exchange_failed on provider failure (no body leak)", async () => {
    upstreamResponder = () =>
      new Response('{"error":"invalid_grant","secret":"leaky"}', { status: 400 });
    const state = await signedStateFor("google-calendar");
    const res = await api(
      `/api/integrations/google-calendar/callback?code=bad&state=${encodeURIComponent(state)}`,
      { token: null, env: testEnv },
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("Location")!;
    expect(location).toContain("error=exchange_failed");
    expect(location).not.toContain("leaky");
  });
});

describe("DELETE /api/integrations/:provider", () => {
  it("revokes best-effort and deletes the connection", async () => {
    await upsertConnection(
      testEnv,
      SINGLE_USER_ID,
      "google-calendar",
      connectedTokens(),
    );
    const revoked: string[] = [];
    upstreamResponder = async ({ url, init }) => {
      revoked.push(url);
      expect(new URLSearchParams(String(init.body)).get("token")).toBe(
        "cal-refresh",
      );
      return new Response("{}", { status: 200 });
    };
    const res = await api("/api/integrations/google-calendar", {
      method: "DELETE",
      env: testEnv,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(revoked).toEqual(["https://oauth2.googleapis.com/revoke"]);
    expect(
      await getConnection(testEnv, SINGLE_USER_ID, "google-calendar"),
    ).toBeNull();
  });

  it("404s with not_connected when nothing is connected", async () => {
    const res = await api("/api/integrations/google-calendar", {
      method: "DELETE",
      env: testEnv,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_connected");
  });
});

describe("GET /api/integrations/google-calendar/events", () => {
  it("404s with not_connected when no connection exists", async () => {
    const res = await api("/api/integrations/google-calendar/events", {
      env: testEnv,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_connected");
  });

  it("returns normalized events", async () => {
    await upsertConnection(
      testEnv,
      SINGLE_USER_ID,
      "google-calendar",
      connectedTokens(),
    );
    upstreamResponder = ({ url, init }) => {
      const u = new URL(url);
      expect(u.origin + u.pathname).toBe(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      );
      expect(u.searchParams.get("singleEvents")).toBe("true");
      expect(u.searchParams.get("orderBy")).toBe("startTime");
      expect(init.headers.get("Authorization")).toBe("Bearer cal-access");
      return Response.json({
        items: [
          {
            id: "evt-1",
            summary: "Standup",
            start: { dateTime: "2026-07-22T09:00:00Z" },
            end: { dateTime: "2026-07-22T09:15:00Z" },
            attendees: [
              { email: "a@example.com", displayName: "A" },
              { displayName: "no-email-resource" },
            ],
            hangoutLink: "https://meet.google.com/abc",
            htmlLink: "https://calendar.google.com/event?eid=1",
          },
          { id: "evt-cancelled", status: "cancelled" },
        ],
      });
    };
    const res = await api("/api/integrations/google-calendar/events?days=7", {
      env: testEnv,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      events: [
        {
          id: "evt-1",
          title: "Standup",
          startsAt: "2026-07-22T09:00:00Z",
          endsAt: "2026-07-22T09:15:00Z",
          attendees: [{ email: "a@example.com", name: "A" }],
          meetLink: "https://meet.google.com/abc",
          htmlLink: "https://calendar.google.com/event?eid=1",
        },
      ],
    });
  });

  it("maps upstream failure to 502 provider_error", async () => {
    await upsertConnection(
      testEnv,
      SINGLE_USER_ID,
      "google-calendar",
      connectedTokens(),
    );
    upstreamResponder = () => new Response("boom", { status: 500 });
    const res = await api("/api/integrations/google-calendar/events", {
      env: testEnv,
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("provider_error");
  });

  it("returns 409 reconnect_required when refresh fails, flipping status", async () => {
    await upsertConnection(
      testEnv,
      SINGLE_USER_ID,
      "google-calendar",
      connectedTokens({ expiresAt: Date.now() - 1000 }),
    );
    upstreamResponder = ({ url }) => {
      expect(url).toBe("https://oauth2.googleapis.com/token");
      return new Response('{"error":"invalid_grant"}', { status: 400 });
    };
    const res = await api("/api/integrations/google-calendar/events", {
      env: testEnv,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("reconnect_required");
    const conn = await getConnection(testEnv, SINGLE_USER_ID, "google-calendar");
    expect(conn!.status).toBe("error");
  });

  it("transparently refreshes an expired token then lists events", async () => {
    await upsertConnection(
      testEnv,
      SINGLE_USER_ID,
      "google-calendar",
      connectedTokens({ expiresAt: Date.now() - 1000 }),
    );
    upstreamResponder = ({ url, init }) => {
      if (url === "https://oauth2.googleapis.com/token") {
        const params = new URLSearchParams(String(init.body));
        expect(params.get("grant_type")).toBe("refresh_token");
        expect(params.get("refresh_token")).toBe("cal-refresh");
        return Response.json({
          access_token: "fresh-access",
          expires_in: 3600,
          token_type: "Bearer",
        });
      }
      expect(init.headers.get("Authorization")).toBe("Bearer fresh-access");
      return Response.json({ items: [] });
    };
    const res = await api("/api/integrations/google-calendar/events", {
      env: testEnv,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: [] });
    expect(upstreamCalls).toHaveLength(2);
  });
});
