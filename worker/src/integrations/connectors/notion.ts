/**
 * Notion connector (section 40 T4). Notion-Version 2025-09-03 (data-source
 * model: databases are containers; search returns `data_source` objects and
 * pages are created under a `data_source_id` parent).
 *
 * OAuth: token exchange uses HTTP Basic auth (client_id:client_secret).
 * Notion tokens do not expire and there is no refresh flow; a revoked token
 * surfaces as a provider error → "Reconnect" in the UI. Notion also has no
 * programmatic revoke endpoint, so disconnect just deletes the rows.
 *
 * Actions (all take a plaintext access token from the caller; no return type
 * ever contains token material):
 * - `listNotionDatabases`   → search filter object=data_source → [{id,title}]
 *   (`id` is the data_source id — the export target).
 * - `listNotionPages(query)`→ search filter object=page → [{id,title}] picker.
 * - `exportNotionSummary`   → create one page (title property + heading/
 *   paragraph blocks for the summary + to_do blocks for action items).
 * - `importNotionPages`     → per page: fetch meta + paginated block children,
 *   flatten rich text to plain text, then hand a canonical
 *   `MemoryDocumentInput` to the INJECTED ingest callback.
 *
 * Memory-ingest seam: `importNotionPages` accepts an
 * `ingestDocument: MemoryDocumentIngest` callback so this module stays free
 * of D1/queue plumbing. routes.ts passes the internal service
 * `ingestMemoryDocument` (worker/src/services/memory-document.ts — the
 * plan's "internal document-ingest service", also backing
 * POST /api/memory/documents); tests inject a fake.
 */

import type { Env } from "../../env";
import type { Connector } from "../types";
import type { MemoryDocumentInput } from "../../services/memory-document";
import {
  type OAuthClientCredentials,
  type TokenSet,
  ConnectorProviderError,
  ValidationError,
  base64Encode,
  readJsonSafe,
  splitTextChunks,
} from "./shared";

export const NOTION_AUTHORIZE_URL = "https://api.notion.com/v1/oauth/authorize";
export const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token";
export const NOTION_API_BASE = "https://api.notion.com/v1";
export const NOTION_VERSION = "2025-09-03";

/** Notion caps rich_text content at 2000 chars per text object. */
export const NOTION_MAX_TEXT_LENGTH = 2000;
/** Notion caps children at 100 blocks per pages.create request. */
export const NOTION_MAX_CHILDREN_PER_REQUEST = 100;

// ---------------------------------------------------------------------------
// OAuth helpers
// ---------------------------------------------------------------------------

/** Build the Notion consent URL (`owner=user` per plan §2). */
export function notionAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(NOTION_AUTHORIZE_URL);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("owner", "user");
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("state", params.state);
  return url.toString();
}

interface NotionTokenResponse {
  access_token?: string;
  token_type?: string;
  workspace_id?: string;
  workspace_name?: string | null;
  workspace_icon?: string | null;
  bot_id?: string;
  error?: string;
}

/**
 * Exchange the OAuth callback `code` for a TokenSet. Notion requires HTTP
 * Basic auth (base64(client_id:client_secret)) on the token endpoint.
 */
export async function exchangeNotionCode(params: {
  code: string;
  redirectUri: string;
  credentials: OAuthClientCredentials;
}): Promise<TokenSet> {
  const basic = base64Encode(
    `${params.credentials.clientId}:${params.credentials.clientSecret}`,
  );
  const res = await fetch(NOTION_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
    }),
  });
  const body = (await readJsonSafe(res)) as NotionTokenResponse | null;
  if (!res.ok) {
    const code = body?.error ?? `http_${res.status}`;
    throw new ConnectorProviderError(
      "notion",
      code,
      `Notion token exchange failed (${code})`,
      res.status,
    );
  }
  if (!body?.access_token) {
    throw new ConnectorProviderError("notion", "no_access_token", "Notion returned no access_token");
  }
  return {
    accessToken: body.access_token,
    // Notion tokens never expire; no refresh token.
    tokenType: body.token_type ?? "bearer",
    scopes: "", // Notion has no scope string (capabilities live on the app).
    externalAccountId: body.workspace_id ?? "",
    displayName: body.workspace_name ?? "Notion workspace",
    metadata: {
      ...(body.workspace_icon ? { workspaceIcon: body.workspace_icon } : {}),
      ...(body.bot_id ? { botId: body.bot_id } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Notion API plumbing
// ---------------------------------------------------------------------------

async function notionFetch(
  accessToken: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Record<string, unknown>> {
  const res = await fetch(`${NOTION_API_BASE}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Notion-Version": NOTION_VERSION,
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const body = await readJsonSafe(res);
  if (!res.ok) {
    const code = typeof body?.code === "string" ? body.code : `http_${res.status}`;
    throw new ConnectorProviderError(
      "notion",
      code,
      `Notion API ${init.method ?? "GET"} ${path} failed (${code})`,
      res.status,
    );
  }
  return body ?? {};
}

interface RichTextItem {
  plain_text?: string;
}

/** Flatten a Notion rich_text array to its plain text. */
export function flattenRichText(richText: unknown): string {
  if (!Array.isArray(richText)) return "";
  return (richText as RichTextItem[])
    .map((item) => (typeof item?.plain_text === "string" ? item.plain_text : ""))
    .join("");
}

// ---------------------------------------------------------------------------
// Pickers: databases (data sources) + pages
// ---------------------------------------------------------------------------

export interface NotionDatabase {
  /** data_source id — use as the export target (`databaseId` in the API). */
  id: string;
  title: string;
}

export interface NotionPage {
  id: string;
  title: string;
}

interface SearchResult {
  object?: string;
  id?: string;
  title?: unknown;
  properties?: Record<string, { type?: string; title?: unknown }>;
  url?: string;
}

interface SearchResponse {
  results?: SearchResult[];
  has_more?: boolean;
  next_cursor?: string | null;
}

const MAX_SEARCH_PAGES = 10;

async function notionSearch(
  accessToken: string,
  objectFilter: "data_source" | "page",
  query?: string,
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
    const body = (await notionFetch(accessToken, "/search", {
      method: "POST",
      body: {
        ...(query ? { query } : {}),
        filter: { property: "object", value: objectFilter },
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      },
    })) as SearchResponse;
    results.push(...(body.results ?? []));
    if (!body.has_more || !body.next_cursor) break;
    cursor = body.next_cursor;
  }
  return results;
}

/** Extract the title of a page object (the property whose type is "title"). */
function pageTitle(result: SearchResult): string {
  for (const prop of Object.values(result.properties ?? {})) {
    if (prop?.type === "title") {
      const text = flattenRichText(prop.title);
      if (text) return text;
    }
  }
  return "Untitled";
}

/** Databases picker: search filter object=data_source → [{ id, title }]. */
export async function listNotionDatabases(
  accessToken: string,
): Promise<{ databases: NotionDatabase[] }> {
  const results = await notionSearch(accessToken, "data_source");
  const databases = results
    .filter((r) => typeof r.id === "string")
    .map((r) => ({
      id: r.id as string,
      title: flattenRichText(r.title) || "Untitled",
    }));
  return { databases };
}

/** Pages picker for import: search filter object=page → [{ id, title }]. */
export async function listNotionPages(
  accessToken: string,
  query?: string,
): Promise<{ pages: NotionPage[] }> {
  const results = await notionSearch(accessToken, "page", query?.trim() || undefined);
  const pages = results
    .filter((r) => typeof r.id === "string")
    .map((r) => ({ id: r.id as string, title: pageTitle(r) }));
  return { pages };
}

// ---------------------------------------------------------------------------
// Export: create a summary page in a database (data source)
// ---------------------------------------------------------------------------

export interface NotionExportInput {
  /** data_source id from `listNotionDatabases` (plan API name: databaseId). */
  databaseId: string;
  title: string;
  summary: string;
  actionItems: string[];
  /** Traceability only — recorded on the page as a paragraph footer. */
  sessionId?: string;
}

type NotionBlock = Record<string, unknown>;

function richText(content: string): { type: "text"; text: { content: string } }[] {
  return splitTextChunks(content, NOTION_MAX_TEXT_LENGTH).map((chunk) => ({
    type: "text" as const,
    text: { content: chunk },
  }));
}

function paragraphBlocks(text: string): NotionBlock[] {
  // One paragraph block per line group; each block's rich_text respects the
  // 2000-char text cap via splitTextChunks.
  return text
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter((para) => para.length > 0)
    .map((para) => ({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: richText(para) },
    }));
}

/** Build the children blocks for an exported summary page (exported for
 * golden tests). */
export function buildExportBlocks(input: NotionExportInput): NotionBlock[] {
  const blocks: NotionBlock[] = [
    {
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: richText("Summary") },
    },
    ...paragraphBlocks(input.summary),
  ];
  if (input.actionItems.length > 0) {
    blocks.push({
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: richText("Action items") },
    });
    for (const item of input.actionItems) {
      blocks.push({
        object: "block",
        type: "to_do",
        to_do: { rich_text: richText(item), checked: false },
      });
    }
  }
  if (input.sessionId) {
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: richText(`Littlebird session: ${input.sessionId}`) },
    });
  }
  return blocks.slice(0, NOTION_MAX_CHILDREN_PER_REQUEST);
}

/**
 * Create one summary page under the chosen data source: title property +
 * heading/paragraph blocks for the summary + to_do blocks for action items.
 */
export async function exportNotionSummary(
  accessToken: string,
  input: NotionExportInput,
): Promise<{ pageId: string; url: string }> {
  if (typeof input.databaseId !== "string" || !input.databaseId.trim()) {
    throw new ValidationError("'databaseId' must be a non-empty string");
  }
  if (typeof input.title !== "string" || !input.title.trim()) {
    throw new ValidationError("'title' must be a non-empty string");
  }
  if (typeof input.summary !== "string" || !input.summary.trim()) {
    throw new ValidationError("'summary' must be a non-empty string");
  }
  if (
    !Array.isArray(input.actionItems) ||
    input.actionItems.some((item) => typeof item !== "string")
  ) {
    throw new ValidationError("'actionItems' must be an array of strings");
  }

  const body = await notionFetch(accessToken, "/pages", {
    method: "POST",
    body: {
      parent: { type: "data_source_id", data_source_id: input.databaseId },
      properties: {
        title: { title: richText(input.title) },
      },
      children: buildExportBlocks(input),
    },
  });
  const pageId = typeof body.id === "string" ? body.id : "";
  if (!pageId) {
    throw new ConnectorProviderError("notion", "no_page_id", "Notion page create returned no id");
  }
  return { pageId, url: typeof body.url === "string" ? body.url : "" };
}

// ---------------------------------------------------------------------------
// Import: block children → plain text → memory ingest
// ---------------------------------------------------------------------------

interface NotionBlockResult {
  id?: string;
  type?: string;
  has_children?: boolean;
  [key: string]: unknown;
}

interface BlockChildrenResponse {
  results?: NotionBlockResult[];
  has_more?: boolean;
  next_cursor?: string | null;
}

/** Depth limit for nested block recursion (toggles, nested lists, ...). */
const MAX_BLOCK_DEPTH = 3;
/** Upper bound on children pages fetched per block level. */
const MAX_BLOCK_PAGES = 30;

/**
 * Flatten one Notion block to a plain-text line ("" = contributes nothing).
 * Exported for unit tests.
 */
export function flattenBlock(block: NotionBlockResult): string {
  const type = block.type;
  if (typeof type !== "string") return "";
  const payload = block[type] as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") return "";

  switch (type) {
    case "to_do": {
      const text = flattenRichText(payload.rich_text);
      if (!text) return "";
      return `${payload.checked === true ? "[x]" : "[ ]"} ${text}`;
    }
    case "bulleted_list_item":
    case "numbered_list_item": {
      const text = flattenRichText(payload.rich_text);
      return text ? `- ${text}` : "";
    }
    case "code":
      return flattenRichText(payload.rich_text);
    case "child_page":
      return typeof payload.title === "string" ? payload.title : "";
    case "equation":
      return typeof payload.expression === "string" ? payload.expression : "";
    case "table_row": {
      const cells = Array.isArray(payload.cells) ? payload.cells : [];
      return cells
        .map((cell) => flattenRichText(cell))
        .filter((t) => t.length > 0)
        .join(" | ");
    }
    default:
      // paragraph, heading_1..3, quote, callout, toggle, ... all carry a
      // rich_text array under their type key.
      return flattenRichText(payload.rich_text);
  }
}

async function fetchBlockChildren(
  accessToken: string,
  blockId: string,
): Promise<NotionBlockResult[]> {
  const results: NotionBlockResult[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_BLOCK_PAGES; page++) {
    const qs = new URLSearchParams({ page_size: "100" });
    if (cursor) qs.set("start_cursor", cursor);
    const body = (await notionFetch(
      accessToken,
      `/blocks/${blockId}/children?${qs.toString()}`,
    )) as BlockChildrenResponse;
    results.push(...(body.results ?? []));
    if (!body.has_more || !body.next_cursor) break;
    cursor = body.next_cursor;
  }
  return results;
}

/** Recursively flatten a page's block tree to plain text lines. */
async function flattenPageText(
  accessToken: string,
  blockId: string,
  depth: number,
  lines: string[],
): Promise<void> {
  const blocks = await fetchBlockChildren(accessToken, blockId);
  for (const block of blocks) {
    const line = flattenBlock(block);
    if (line) lines.push(line);
    // Recurse into nested content, but never into full child pages/databases.
    if (
      block.has_children === true &&
      typeof block.id === "string" &&
      block.type !== "child_page" &&
      block.type !== "child_database" &&
      depth < MAX_BLOCK_DEPTH
    ) {
      await flattenPageText(accessToken, block.id, depth + 1, lines);
    }
  }
}

/**
 * Injected memory-ingest seam (see module docstring): the canonical document
 * upsert + queue enqueue from POST /api/memory/documents, as a function.
 * Must be idempotent per (user_id, source, external_id) — routes/memory.ts's
 * upsert already is.
 */
export type MemoryDocumentIngest = (
  doc: MemoryDocumentInput,
) => Promise<{ id: string }>;

export interface NotionImportResult {
  imported: { pageId: string; documentId: string }[];
}

const MAX_IMPORT_PAGES = 20;

/**
 * Import Notion pages into memory: fetch page meta (title/url) + paginated
 * block children, flatten to plain text, then ingest via the injected
 * callback with `{ title, source: "notion", text, external_id: <page id>,
 * metadata: { url } }` (idempotent re-import per plan §4).
 */
export async function importNotionPages(
  accessToken: string,
  pageIds: string[],
  ingestDocument: MemoryDocumentIngest,
): Promise<NotionImportResult> {
  if (!Array.isArray(pageIds) || pageIds.length === 0) {
    throw new ValidationError("'pageIds' must be a non-empty array of strings");
  }
  if (pageIds.some((id) => typeof id !== "string" || !id.trim())) {
    throw new ValidationError("'pageIds' entries must be non-empty strings");
  }
  if (pageIds.length > MAX_IMPORT_PAGES) {
    throw new ValidationError(`At most ${MAX_IMPORT_PAGES} pages per import`);
  }

  const imported: { pageId: string; documentId: string }[] = [];
  for (const pageId of pageIds) {
    const page = (await notionFetch(accessToken, `/pages/${pageId}`)) as SearchResult;
    const title = pageTitle(page);
    const url = typeof page.url === "string" ? page.url : undefined;

    const lines: string[] = [];
    await flattenPageText(accessToken, pageId, 0, lines);
    const text = lines.join("\n").trim();

    const doc = await ingestDocument({
      title,
      source: "notion",
      // Ingest requires non-empty text; an empty page still imports its title.
      text: text || title,
      external_id: pageId,
      ...(url ? { metadata: { url } } : {}),
    });
    imported.push({ pageId, documentId: doc.id });
  }
  return { imported };
}

// ---------------------------------------------------------------------------
// Framework Connector object (registry.ts registers this)
// ---------------------------------------------------------------------------

/** Notion tokens never expire (no `refresh`) and Notion has no programmatic
 * revoke endpoint (no `revoke`) — disconnect just deletes the rows. */
export const notionConnector: Connector = {
  slug: "notion",

  isConfigured(env: Env) {
    return Boolean(env.NOTION_CLIENT_ID && env.NOTION_CLIENT_SECRET);
  },

  authorizeUrl({ state, redirectUri, env }) {
    return notionAuthorizeUrl({
      clientId: env.NOTION_CLIENT_ID ?? "",
      redirectUri,
      state,
    });
  },

  async exchangeCode({ code, redirectUri, env }) {
    return exchangeNotionCode({
      code,
      redirectUri,
      credentials: {
        clientId: env.NOTION_CLIENT_ID ?? "",
        clientSecret: env.NOTION_CLIENT_SECRET ?? "",
      },
    });
  },
};
