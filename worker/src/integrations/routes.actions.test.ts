/**
 * Action-endpoint tests for the gmail / slack / notion connectors (T4):
 * connection gating (not_connected / reconnect_required), token decryption
 * via the store, upstream calls (stubbed fetch), error mapping, and the
 * Notion import → internal memory-document ingest path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { api } from "../../test/helpers";
import type { Env } from "../env";
import { SINGLE_USER_ID } from "../auth";
import { upsertConnection } from "./store";
import type { ProviderSlug, TokenSet } from "./types";

const testEnv = env as unknown as Env;

type FetchArgs = { url: string; init: RequestInit & { headers: Headers } };
let upstreamCalls: FetchArgs[];
let upstreamResponder: (args: FetchArgs) => Response | Promise<Response>;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  upstreamCalls = [];
  upstreamResponder = () => {
    throw new Error("unexpected upstream fetch");
  };
  await testEnv.DB.batch([
    testEnv.DB.prepare("DELETE FROM integration_connections"),
    testEnv.DB.prepare("DELETE FROM oauth_states"),
    testEnv.DB.prepare("DELETE FROM memory_documents"),
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

/** Seed an active connection with a stored (encrypted) token. */
async function connect(
  provider: ProviderSlug,
  overrides: Partial<TokenSet> = {},
): Promise<void> {
  const tokens: TokenSet = {
    accessToken: `${provider}-access-token`,
    tokenType: "Bearer",
    scopes: "",
    externalAccountId: `${provider}-account`,
    displayName: `${provider} account`,
    // Slack/Notion tokens don't expire; Gmail gets a far-future expiry so
    // no refresh is attempted in these tests.
    ...(provider === "gmail" ? { expiresAt: Date.now() + 3600_000 } : {}),
    ...overrides,
  };
  await upsertConnection(testEnv, SINGLE_USER_ID, provider, tokens);
}

describe("POST /api/integrations/gmail/send", () => {
  const BODY = { to: ["a@example.com"], subject: "Hi", bodyText: "hello" };

  it("404s not_connected without a connection", async () => {
    const res = await api("/api/integrations/gmail/send", {
      method: "POST",
      body: BODY,
      env: testEnv,
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "not_connected",
    );
    expect(upstreamCalls).toHaveLength(0);
  });

  it("sends via Gmail with the decrypted token and returns { messageId }", async () => {
    await connect("gmail");
    upstreamResponder = ({ url, init }) => {
      expect(url).toBe(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      );
      expect(init.headers.get("Authorization")).toBe("Bearer gmail-access-token");
      expect(JSON.parse(String(init.body))).toHaveProperty("raw");
      return Response.json({ id: "msg-1" });
    };
    const res = await api("/api/integrations/gmail/send", {
      method: "POST",
      body: BODY,
      env: testEnv,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ messageId: "msg-1" });
    expect(JSON.stringify(json)).not.toContain("gmail-access-token");
  });

  it("400s bad_request on invalid recipients without hitting upstream", async () => {
    await connect("gmail");
    const res = await api("/api/integrations/gmail/send", {
      method: "POST",
      body: { to: ["not-an-email"], subject: "s", bodyText: "b" },
      env: testEnv,
    });
    expect(res.status).toBe(400);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("502s provider_error on upstream failure", async () => {
    await connect("gmail");
    upstreamResponder = () =>
      Response.json({ error: { status: "PERMISSION_DENIED" } }, { status: 403 });
    const res = await api("/api/integrations/gmail/send", {
      method: "POST",
      body: BODY,
      env: testEnv,
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("provider_error");
    expect(body.error.message).toContain("PERMISSION_DENIED");
  });
});

describe("GET /api/integrations/slack/channels", () => {
  it("flattens paginated channels", async () => {
    await connect("slack");
    upstreamResponder = ({ url }) => {
      const cursor = new URL(url).searchParams.get("cursor");
      if (!cursor) {
        return Response.json({
          ok: true,
          channels: [{ id: "C1", name: "general" }],
          response_metadata: { next_cursor: "c2" },
        });
      }
      return Response.json({ ok: true, channels: [{ id: "C2", name: "random" }] });
    };
    const res = await api("/api/integrations/slack/channels", { env: testEnv });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      channels: [
        { id: "C1", name: "general" },
        { id: "C2", name: "random" },
      ],
    });
  });

  it("404s not_connected without a connection", async () => {
    const res = await api("/api/integrations/slack/channels", { env: testEnv });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/integrations/slack/send", () => {
  it("posts and returns { ok, ts }", async () => {
    await connect("slack");
    upstreamResponder = ({ init }) => {
      expect(init.headers.get("Authorization")).toBe("Bearer slack-access-token");
      return Response.json({ ok: true, ts: "123.456" });
    };
    const res = await api("/api/integrations/slack/send", {
      method: "POST",
      body: { channelId: "C1", text: "summary" },
      env: testEnv,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ts: "123.456" });
  });

  it("surfaces not_in_channel verbatim inside provider_error", async () => {
    await connect("slack");
    upstreamResponder = () => Response.json({ ok: false, error: "not_in_channel" });
    const res = await api("/api/integrations/slack/send", {
      method: "POST",
      body: { channelId: "C9", text: "hi" },
      env: testEnv,
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("provider_error");
    expect(body.error.message).toContain("not_in_channel");
  });

  it("400s on missing fields", async () => {
    await connect("slack");
    const res = await api("/api/integrations/slack/send", {
      method: "POST",
      body: { channelId: "C1" },
      env: testEnv,
    });
    expect(res.status).toBe(400);
    expect(upstreamCalls).toHaveLength(0);
  });
});

describe("Notion action endpoints", () => {
  const rt = (text: string) => [{ plain_text: text }];

  it("GET /databases lists data sources", async () => {
    await connect("notion");
    upstreamResponder = ({ url, init }) => {
      expect(url).toBe("https://api.notion.com/v1/search");
      expect(init.headers.get("Notion-Version")).toBe("2025-09-03");
      return Response.json({
        results: [{ object: "data_source", id: "ds-1", title: rt("Meetings") }],
        has_more: false,
      });
    };
    const res = await api("/api/integrations/notion/databases", { env: testEnv });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      databases: [{ id: "ds-1", title: "Meetings" }],
    });
  });

  it("GET /pages passes the query through", async () => {
    await connect("notion");
    upstreamResponder = ({ init }) => {
      const body = JSON.parse(String(init.body)) as { query?: string };
      expect(body.query).toBe("roadmap");
      return Response.json({
        results: [
          {
            object: "page",
            id: "pg-1",
            properties: { Name: { type: "title", title: rt("Q3 Roadmap") } },
          },
        ],
        has_more: false,
      });
    };
    const res = await api("/api/integrations/notion/pages?query=roadmap", {
      env: testEnv,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      pages: [{ id: "pg-1", title: "Q3 Roadmap" }],
    });
  });

  it("POST /export creates the summary page and returns { pageId, url }", async () => {
    await connect("notion");
    upstreamResponder = ({ url, init }) => {
      expect(url).toBe("https://api.notion.com/v1/pages");
      const body = JSON.parse(String(init.body)) as { parent: unknown };
      expect(body.parent).toEqual({ type: "data_source_id", data_source_id: "ds-1" });
      return Response.json({ id: "pg-new", url: "https://notion.so/pg-new" });
    };
    const res = await api("/api/integrations/notion/export", {
      method: "POST",
      body: {
        databaseId: "ds-1",
        title: "Standup",
        summary: "We discussed things.",
        actionItems: ["Follow up"],
      },
      env: testEnv,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      pageId: "pg-new",
      url: "https://notion.so/pg-new",
    });
  });

  it("POST /import flattens pages into memory documents via the internal service", async () => {
    await connect("notion");
    upstreamResponder = ({ url }) => {
      const u = new URL(url);
      if (u.pathname === "/v1/pages/pg-1") {
        return Response.json({
          id: "pg-1",
          url: "https://notion.so/pg-1",
          properties: { Name: { type: "title", title: rt("Design doc") } },
        });
      }
      if (u.pathname === "/v1/blocks/pg-1/children") {
        return Response.json({
          results: [
            { id: "b1", type: "paragraph", paragraph: { rich_text: rt("Body text.") } },
          ],
          has_more: false,
        });
      }
      throw new Error(`unexpected path ${u.pathname}`);
    };

    const res = await api("/api/integrations/notion/import", {
      method: "POST",
      body: { pageIds: ["pg-1"] },
      env: testEnv,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      imported: { pageId: string; documentId: string }[];
    };
    expect(json.imported).toHaveLength(1);
    expect(json.imported[0].pageId).toBe("pg-1");

    // The document row exists, keyed for idempotent re-import.
    const doc = await testEnv.DB.prepare(
      `SELECT title, source, external_id, text FROM memory_documents WHERE id = ?`,
    )
      .bind(json.imported[0].documentId)
      .first<{ title: string; source: string; external_id: string; text: string }>();
    expect(doc).toEqual({
      title: "Design doc",
      source: "notion",
      external_id: "pg-1",
      text: "Body text.",
    });
  });

  it("POST /import 400s on an empty pageIds array", async () => {
    await connect("notion");
    const res = await api("/api/integrations/notion/import", {
      method: "POST",
      body: { pageIds: [] },
      env: testEnv,
    });
    expect(res.status).toBe(400);
    expect(upstreamCalls).toHaveLength(0);
  });
});
