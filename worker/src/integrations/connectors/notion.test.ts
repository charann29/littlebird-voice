import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../../env";
import {
  NOTION_VERSION,
  notionConnector,
  buildExportBlocks,
  exchangeNotionCode,
  exportNotionSummary,
  flattenBlock,
  flattenRichText,
  importNotionPages,
  listNotionDatabases,
  listNotionPages,
  notionAuthorizeUrl,
  type MemoryDocumentIngest,
} from "./notion";
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

const CREDS = { clientId: "notion-client-id", clientSecret: "notion-secret" };

const rt = (text: string) => [{ plain_text: text }];

describe("notionAuthorizeUrl", () => {
  it("builds the consent URL with owner=user", () => {
    const url = new URL(
      notionAuthorizeUrl({
        clientId: CREDS.clientId,
        redirectUri: "https://worker.example/api/integrations/notion/callback",
        state: "st-1",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://api.notion.com/v1/oauth/authorize");
    expect(url.searchParams.get("owner")).toBe("user");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("st-1");
  });
});

describe("exchangeNotionCode", () => {
  it("uses Basic auth and maps workspace fields; token never expires", async () => {
    upstreamResponder = ({ url, init }) => {
      expect(url).toBe("https://api.notion.com/v1/oauth/token");
      expect(init.headers.get("Authorization")).toBe(
        `Basic ${btoa(`${CREDS.clientId}:${CREDS.clientSecret}`)}`,
      );
      expect(JSON.parse(String(init.body))).toEqual({
        grant_type: "authorization_code",
        code: "notion-code",
        redirect_uri: "https://worker.example/cb",
      });
      return Response.json({
        access_token: "ntn-secret-token",
        token_type: "bearer",
        workspace_id: "ws-1",
        workspace_name: "Acme Notes",
        workspace_icon: "🪶",
        bot_id: "bot-1",
      });
    };
    const tokens = await exchangeNotionCode({
      code: "notion-code",
      redirectUri: "https://worker.example/cb",
      credentials: CREDS,
    });
    expect(tokens.accessToken).toBe("ntn-secret-token");
    expect(tokens.refreshToken).toBeUndefined();
    expect(tokens.expiresAt).toBeUndefined();
    expect(tokens.scopes).toBe("");
    expect(tokens.externalAccountId).toBe("ws-1");
    expect(tokens.displayName).toBe("Acme Notes");
    expect(tokens.metadata).toEqual({ workspaceIcon: "🪶", botId: "bot-1" });
  });

  it("maps failures to ProviderError with Notion's error code", async () => {
    upstreamResponder = () =>
      Response.json({ error: "invalid_grant" }, { status: 400 });
    await expect(
      exchangeNotionCode({ code: "bad", redirectUri: "https://x", credentials: CREDS }),
    ).rejects.toMatchObject({ name: "ProviderError", code: "invalid_grant" });
  });
});

describe("listNotionDatabases / listNotionPages", () => {
  it("searches data sources with the pinned Notion-Version and paginates", async () => {
    upstreamResponder = ({ url, init }) => {
      expect(url).toBe("https://api.notion.com/v1/search");
      expect(init.headers.get("Notion-Version")).toBe(NOTION_VERSION);
      expect(init.headers.get("Authorization")).toBe("Bearer ntn-tok");
      const body = JSON.parse(String(init.body)) as {
        filter: unknown;
        start_cursor?: string;
      };
      expect(body.filter).toEqual({ property: "object", value: "data_source" });
      if (!body.start_cursor) {
        return Response.json({
          results: [{ object: "data_source", id: "ds-1", title: rt("Meetings") }],
          has_more: true,
          next_cursor: "cur-2",
        });
      }
      return Response.json({
        results: [{ object: "data_source", id: "ds-2", title: rt("Notes") }],
        has_more: false,
        next_cursor: null,
      });
    };
    const result = await listNotionDatabases("ntn-tok");
    expect(result).toEqual({
      databases: [
        { id: "ds-1", title: "Meetings" },
        { id: "ds-2", title: "Notes" },
      ],
    });
    expect(upstreamCalls).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("ntn-tok");
  });

  it("lists pages with the title extracted from the title property", async () => {
    upstreamResponder = ({ init }) => {
      const body = JSON.parse(String(init.body)) as { filter: unknown; query?: string };
      expect(body.filter).toEqual({ property: "object", value: "page" });
      expect(body.query).toBe("roadmap");
      return Response.json({
        results: [
          {
            object: "page",
            id: "pg-1",
            properties: {
              Name: { type: "title", title: rt("Q3 Roadmap") },
              Status: { type: "select" },
            },
          },
          { object: "page", id: "pg-2", properties: {} },
        ],
        has_more: false,
      });
    };
    await expect(listNotionPages("ntn-tok", "roadmap")).resolves.toEqual({
      pages: [
        { id: "pg-1", title: "Q3 Roadmap" },
        { id: "pg-2", title: "Untitled" },
      ],
    });
  });
});

describe("buildExportBlocks", () => {
  it("builds heading + paragraph + to_do blocks (golden)", () => {
    const blocks = buildExportBlocks({
      databaseId: "ds-1",
      title: "Standup",
      summary: "First paragraph.\n\nSecond paragraph.",
      actionItems: ["Ship it", "Write docs"],
      sessionId: "sess-9",
    });
    expect(blocks).toEqual([
      {
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: [{ type: "text", text: { content: "Summary" } }] },
      },
      {
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content: "First paragraph." } }] },
      },
      {
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content: "Second paragraph." } }] },
      },
      {
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: [{ type: "text", text: { content: "Action items" } }] },
      },
      {
        object: "block",
        type: "to_do",
        to_do: {
          rich_text: [{ type: "text", text: { content: "Ship it" } }],
          checked: false,
        },
      },
      {
        object: "block",
        type: "to_do",
        to_do: {
          rich_text: [{ type: "text", text: { content: "Write docs" } }],
          checked: false,
        },
      },
      {
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [{ type: "text", text: { content: "Littlebird session: sess-9" } }],
        },
      },
    ]);
  });

  it("splits >2000-char paragraphs into multiple rich_text items", () => {
    const blocks = buildExportBlocks({
      databaseId: "ds-1",
      title: "T",
      summary: "x".repeat(4500),
      actionItems: [],
    });
    const para = blocks[1] as { paragraph: { rich_text: { text: { content: string } }[] } };
    expect(para.paragraph.rich_text).toHaveLength(3);
    for (const item of para.paragraph.rich_text) {
      expect(item.text.content.length).toBeLessThanOrEqual(2000);
    }
  });

  it("never exceeds Notion's 100-children-per-request cap", () => {
    const blocks = buildExportBlocks({
      databaseId: "ds-1",
      title: "T",
      summary: "s",
      actionItems: Array.from({ length: 150 }, (_, i) => `item ${i}`),
    });
    expect(blocks.length).toBeLessThanOrEqual(100);
  });
});

describe("exportNotionSummary", () => {
  it("creates a page under the data_source parent and returns { pageId, url }", async () => {
    upstreamResponder = ({ url, init }) => {
      expect(url).toBe("https://api.notion.com/v1/pages");
      expect(init.method).toBe("POST");
      const body = JSON.parse(String(init.body)) as {
        parent: unknown;
        properties: unknown;
        children: unknown[];
      };
      expect(body.parent).toEqual({ type: "data_source_id", data_source_id: "ds-1" });
      expect(body.properties).toEqual({
        title: { title: [{ type: "text", text: { content: "Standup notes" } }] },
      });
      expect(body.children.length).toBeGreaterThan(0);
      return Response.json({
        id: "page-new",
        url: "https://notion.so/page-new",
      });
    };
    await expect(
      exportNotionSummary("ntn-tok", {
        databaseId: "ds-1",
        title: "Standup notes",
        summary: "We discussed things.",
        actionItems: ["Follow up"],
      }),
    ).resolves.toEqual({ pageId: "page-new", url: "https://notion.so/page-new" });
  });

  it("validates input before any upstream call", async () => {
    await expect(
      exportNotionSummary("t", {
        databaseId: "",
        title: "T",
        summary: "s",
        actionItems: [],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      exportNotionSummary("t", {
        databaseId: "ds",
        title: "T",
        summary: "s",
        actionItems: [1 as unknown as string],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("maps provider failures (e.g. object_not_found) to ProviderError", async () => {
    upstreamResponder = () =>
      Response.json(
        { object: "error", code: "object_not_found", message: "nope" },
        { status: 404 },
      );
    await expect(
      exportNotionSummary("t", {
        databaseId: "ds-x",
        title: "T",
        summary: "s",
        actionItems: [],
      }),
    ).rejects.toMatchObject({ code: "object_not_found", status: 404 });
  });
});

describe("flattenRichText / flattenBlock", () => {
  it("concatenates plain_text and tolerates junk", () => {
    expect(flattenRichText(rt("a").concat(rt("b")))).toBe("ab");
    expect(flattenRichText(undefined)).toBe("");
    expect(flattenRichText([{ no: "plain_text" }])).toBe("");
  });

  it("flattens the common block types", () => {
    expect(
      flattenBlock({ type: "paragraph", paragraph: { rich_text: rt("hello") } }),
    ).toBe("hello");
    expect(
      flattenBlock({ type: "heading_1", heading_1: { rich_text: rt("Title") } }),
    ).toBe("Title");
    expect(
      flattenBlock({
        type: "to_do",
        to_do: { rich_text: rt("task"), checked: true },
      }),
    ).toBe("[x] task");
    expect(
      flattenBlock({
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: rt("point") },
      }),
    ).toBe("- point");
    expect(
      flattenBlock({
        type: "table_row",
        table_row: { cells: [rt("a"), rt("b")] },
      }),
    ).toBe("a | b");
    expect(flattenBlock({ type: "divider", divider: {} })).toBe("");
    expect(flattenBlock({ type: "image", image: { file: {} } })).toBe("");
  });
});

describe("importNotionPages", () => {
  /** Routes-injected ingest fake (see notion.ts memory-ingest seam note). */
  function fakeIngest(): {
    ingest: MemoryDocumentIngest;
    docs: Parameters<MemoryDocumentIngest>[0][];
  } {
    const docs: Parameters<MemoryDocumentIngest>[0][] = [];
    const ingest: MemoryDocumentIngest = async (doc) => {
      docs.push(doc);
      return { id: `doc-${docs.length}` };
    };
    return { ingest, docs };
  }

  it("fetches page meta + paginated blocks, flattens, and ingests idempotently-keyed docs", async () => {
    upstreamResponder = ({ url }) => {
      const u = new URL(url);
      if (u.pathname === "/v1/pages/pg-1") {
        return Response.json({
          object: "page",
          id: "pg-1",
          url: "https://notion.so/pg-1",
          properties: { Name: { type: "title", title: rt("Design doc") } },
        });
      }
      if (u.pathname === "/v1/blocks/pg-1/children") {
        if (!u.searchParams.get("start_cursor")) {
          return Response.json({
            results: [
              { id: "b1", type: "heading_1", heading_1: { rich_text: rt("Intro") } },
              {
                id: "b2",
                type: "paragraph",
                paragraph: { rich_text: rt("First page of text.") },
                has_children: false,
              },
            ],
            has_more: true,
            next_cursor: "cur-2",
          });
        }
        return Response.json({
          results: [
            {
              id: "b3",
              type: "toggle",
              toggle: { rich_text: rt("Details") },
              has_children: true,
            },
          ],
          has_more: false,
          next_cursor: null,
        });
      }
      if (u.pathname === "/v1/blocks/b3/children") {
        return Response.json({
          results: [
            {
              id: "b4",
              type: "paragraph",
              paragraph: { rich_text: rt("Nested detail.") },
            },
          ],
          has_more: false,
        });
      }
      throw new Error(`unexpected path ${u.pathname}`);
    };

    const { ingest, docs } = fakeIngest();
    const result = await importNotionPages("ntn-tok", ["pg-1"], ingest);
    expect(result).toEqual({ imported: [{ pageId: "pg-1", documentId: "doc-1" }] });
    expect(docs).toEqual([
      {
        title: "Design doc",
        source: "notion",
        text: "Intro\nFirst page of text.\nDetails\nNested detail.",
        external_id: "pg-1",
        metadata: { url: "https://notion.so/pg-1" },
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("ntn-tok");
  });

  it("falls back to the title as text for an empty page", async () => {
    upstreamResponder = ({ url }) => {
      const u = new URL(url);
      if (u.pathname === "/v1/pages/pg-empty") {
        return Response.json({
          id: "pg-empty",
          properties: { title: { type: "title", title: rt("Empty page") } },
        });
      }
      return Response.json({ results: [], has_more: false });
    };
    const { ingest, docs } = fakeIngest();
    await importNotionPages("ntn-tok", ["pg-empty"], ingest);
    expect(docs[0].text).toBe("Empty page");
    expect(docs[0]).not.toHaveProperty("metadata");
  });

  it("does not recurse into child pages or databases", async () => {
    upstreamResponder = ({ url }) => {
      const u = new URL(url);
      if (u.pathname === "/v1/pages/pg-1") {
        return Response.json({ id: "pg-1", properties: {} });
      }
      if (u.pathname === "/v1/blocks/pg-1/children") {
        return Response.json({
          results: [
            {
              id: "child",
              type: "child_page",
              child_page: { title: "Sub page" },
              has_children: true,
            },
          ],
          has_more: false,
        });
      }
      throw new Error(`should not fetch ${u.pathname}`);
    };
    const { ingest, docs } = fakeIngest();
    await importNotionPages("ntn-tok", ["pg-1"], ingest);
    // child_page contributes its title but its subtree is not fetched.
    expect(docs[0].text).toBe("Sub page");
  });

  it("validates pageIds before any upstream or ingest call", async () => {
    const { ingest, docs } = fakeIngest();
    await expect(importNotionPages("t", [], ingest)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      importNotionPages("t", ["  "], ingest),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(upstreamCalls).toHaveLength(0);
    expect(docs).toHaveLength(0);
  });
});

describe("notionConnector (framework Connector object)", () => {
  const env = {
    NOTION_CLIENT_ID: CREDS.clientId,
    NOTION_CLIENT_SECRET: CREDS.clientSecret,
  } as Env;

  it("is configured only when both Notion secrets are present; no refresh/revoke", () => {
    expect(notionConnector.slug).toBe("notion");
    expect(notionConnector.isConfigured(env)).toBe(true);
    expect(notionConnector.isConfigured({} as Env)).toBe(false);
    expect(notionConnector.refresh).toBeUndefined();
    expect(notionConnector.revoke).toBeUndefined();
  });

  it("delegates authorizeUrl/exchangeCode to the helpers with env creds", async () => {
    expect(
      notionConnector.authorizeUrl({ state: "s", redirectUri: "https://r/cb", env }),
    ).toBe(
      notionAuthorizeUrl({ clientId: CREDS.clientId, redirectUri: "https://r/cb", state: "s" }),
    );

    upstreamResponder = ({ init }) => {
      expect(init.headers.get("Authorization")).toBe(
        `Basic ${btoa(`${CREDS.clientId}:${CREDS.clientSecret}`)}`,
      );
      return Response.json({ access_token: "ntn-1", workspace_id: "ws" });
    };
    const tokens = await notionConnector.exchangeCode({
      code: "c",
      redirectUri: "https://r/cb",
      env,
    });
    expect(tokens.accessToken).toBe("ntn-1");
  });
});
