import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../../env";
import {
  SLACK_BOT_SCOPES,
  slackConnector,
  SLACK_MAX_TEXT_LENGTH,
  exchangeSlackCode,
  listSlackChannels,
  postSlackMessage,
  revokeSlackToken,
  slackAuthorizeUrl,
} from "./slack";
import { ValidationError } from "./shared";

/** Same upstream-fetch stub pattern as src/routes/soniox.test.ts. */
type FetchArgs = { url: string; init: RequestInit & { headers: Headers } };

let upstreamCalls: FetchArgs[];
let upstreamResponder: (args: FetchArgs) => Response | Promise<Response>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  upstreamCalls = [];
  upstreamResponder = () => {
    throw new Error("unexpected upstream fetch");
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
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
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.fetch = realFetch;
});

const CREDS = { clientId: "slack-client-id", clientSecret: "slack-secret" };

describe("slackAuthorizeUrl", () => {
  it("builds the v2 authorize URL with bot scopes", () => {
    const url = new URL(
      slackAuthorizeUrl({
        clientId: CREDS.clientId,
        redirectUri: "https://worker.example/api/integrations/slack/callback",
        state: "state-1",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(url.searchParams.get("scope")).toBe(SLACK_BOT_SCOPES);
    expect(url.searchParams.get("client_id")).toBe(CREDS.clientId);
    expect(url.searchParams.get("state")).toBe("state-1");
  });
});

describe("exchangeSlackCode", () => {
  it("exchanges the code and maps team fields; no refresh token (rotation off)", async () => {
    upstreamResponder = ({ url, init }) => {
      expect(url).toBe("https://slack.com/api/oauth.v2.access");
      const form = new URLSearchParams(String(init.body));
      expect(form.get("code")).toBe("slack-code");
      expect(form.get("client_secret")).toBe(CREDS.clientSecret);
      return Response.json({
        ok: true,
        access_token: "xoxb-bot-token",
        token_type: "bot",
        scope: "chat:write,channels:read",
        bot_user_id: "U0BOT",
        team: { id: "T123", name: "Acme Workspace" },
      });
    };
    const tokens = await exchangeSlackCode({
      code: "slack-code",
      redirectUri: "https://worker.example/cb",
      credentials: CREDS,
    });
    expect(tokens.accessToken).toBe("xoxb-bot-token");
    expect(tokens.refreshToken).toBeUndefined();
    expect(tokens.expiresAt).toBeUndefined();
    expect(tokens.scopes).toBe("chat:write channels:read");
    expect(tokens.externalAccountId).toBe("T123");
    expect(tokens.displayName).toBe("Acme Workspace");
    expect(tokens.metadata).toEqual({ botUserId: "U0BOT" });
  });

  it("maps Slack's 200-with-ok:false failure mode to ProviderError", async () => {
    upstreamResponder = () =>
      Response.json({ ok: false, error: "invalid_code" });
    await expect(
      exchangeSlackCode({ code: "bad", redirectUri: "https://x", credentials: CREDS }),
    ).rejects.toMatchObject({ name: "ProviderError", code: "invalid_code" });
  });
});

describe("revokeSlackToken", () => {
  it("is best-effort: never throws even when the request fails", async () => {
    upstreamResponder = () => {
      throw new Error("network down");
    };
    await expect(revokeSlackToken("xoxb-tok")).resolves.toBeUndefined();
    expect(upstreamCalls).toHaveLength(1);
  });
});

describe("listSlackChannels", () => {
  it("flattens paginated conversations.list into { channels }", async () => {
    upstreamResponder = ({ url, init }) => {
      const u = new URL(url);
      expect(u.pathname).toBe("/api/conversations.list");
      expect(u.searchParams.get("types")).toBe("public_channel");
      expect(u.searchParams.get("exclude_archived")).toBe("true");
      expect(init.headers.get("Authorization")).toBe("Bearer xoxb-tok");
      const cursor = u.searchParams.get("cursor");
      if (!cursor) {
        return Response.json({
          ok: true,
          channels: [{ id: "C1", name: "general" }],
          response_metadata: { next_cursor: "cur-2" },
        });
      }
      expect(cursor).toBe("cur-2");
      return Response.json({
        ok: true,
        channels: [{ id: "C2", name: "random" }],
        response_metadata: { next_cursor: "" },
      });
    };
    const result = await listSlackChannels("xoxb-tok");
    expect(result).toEqual({
      channels: [
        { id: "C1", name: "general" },
        { id: "C2", name: "random" },
      ],
    });
    expect(upstreamCalls).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("xoxb-tok");
  });

  it("surfaces Slack error codes (e.g. invalid_auth) as ProviderError", async () => {
    upstreamResponder = () => Response.json({ ok: false, error: "invalid_auth" });
    await expect(listSlackChannels("xoxb-dead")).rejects.toMatchObject({
      code: "invalid_auth",
    });
  });
});

describe("postSlackMessage", () => {
  it("posts to chat.postMessage and returns { ok, ts }", async () => {
    upstreamResponder = ({ url, init }) => {
      expect(url).toBe("https://slack.com/api/chat.postMessage");
      expect(init.headers.get("Authorization")).toBe("Bearer xoxb-tok");
      expect(JSON.parse(String(init.body))).toEqual({
        channel: "C1",
        text: "Meeting summary...",
      });
      return Response.json({ ok: true, ts: "1721556000.000100" });
    };
    await expect(
      postSlackMessage("xoxb-tok", { channelId: "C1", text: "Meeting summary..." }),
    ).resolves.toEqual({ ok: true, ts: "1721556000.000100" });
  });

  it("surfaces not_in_channel verbatim with an invite hint", async () => {
    upstreamResponder = () => Response.json({ ok: false, error: "not_in_channel" });
    await expect(
      postSlackMessage("xoxb-tok", { channelId: "C9", text: "hi" }),
    ).rejects.toMatchObject({
      name: "ProviderError",
      code: "not_in_channel",
      message: expect.stringContaining("invite"),
    });
  });

  it("rejects empty/oversized input before any upstream call", async () => {
    await expect(
      postSlackMessage("t", { channelId: "", text: "hi" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      postSlackMessage("t", { channelId: "C1", text: "   " }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      postSlackMessage("t", {
        channelId: "C1",
        text: "x".repeat(SLACK_MAX_TEXT_LENGTH + 1),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(upstreamCalls).toHaveLength(0);
  });
});

describe("slackConnector (framework Connector object)", () => {
  const env = {
    SLACK_CLIENT_ID: CREDS.clientId,
    SLACK_CLIENT_SECRET: CREDS.clientSecret,
  } as Env;

  it("is configured only when both Slack secrets are present; no refresh (rotation off)", () => {
    expect(slackConnector.slug).toBe("slack");
    expect(slackConnector.isConfigured(env)).toBe(true);
    expect(slackConnector.isConfigured({} as Env)).toBe(false);
    expect(slackConnector.refresh).toBeUndefined();
  });

  it("delegates authorizeUrl/exchangeCode to the helpers with env creds", async () => {
    expect(
      slackConnector.authorizeUrl({ state: "s", redirectUri: "https://r/cb", env }),
    ).toBe(
      slackAuthorizeUrl({ clientId: CREDS.clientId, redirectUri: "https://r/cb", state: "s" }),
    );

    upstreamResponder = ({ init }) => {
      const form = new URLSearchParams(String(init.body));
      expect(form.get("client_id")).toBe(CREDS.clientId);
      return Response.json({
        ok: true,
        access_token: "xoxb-1",
        team: { id: "T1", name: "W" },
      });
    };
    const tokens = await slackConnector.exchangeCode({
      code: "c",
      redirectUri: "https://r/cb",
      env,
    });
    expect(tokens.accessToken).toBe("xoxb-1");
  });
});
