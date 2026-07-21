import { describe, it, expect } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../index";
import type { Env } from "../env";
import type { IngestMessage } from "../services/ingest-message";
import { api, testEnv } from "../../test/helpers";
import { ingestMemory } from "../memory/ingest";
import {
  RecordingIndex,
  RecordingProvider,
  SINGLE_USER_ID,
  chunkCount,
  seedSegments,
  seedSession,
} from "../../test/memory-helpers";

/** api() variant that returns the recorded queue messages too. */
async function apiWithQueue(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<{ res: Response; sent: IngestMessage[] }> {
  const { env: e, sent } = testEnv();
  const res = await api(path, { ...opts, env: e });
  return { res, sent };
}

describe("POST /api/memory/documents", () => {
  it("returns 202 {id, status:'queued'} and enqueues a document message", async () => {
    const { res, sent } = await apiWithQueue("/api/memory/documents", {
      method: "POST",
      body: {
        title: "Notion page",
        source: "notion",
        text: "External knowledge worth indexing.",
        external_id: "page-1",
        metadata: { url: "https://notion.so/page-1" },
      },
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.status).toBe("queued");
    expect(body.id).toBeTruthy();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      userId: SINGLE_USER_ID,
      kind: "document",
      parentId: body.id,
      sourceRevision: 1,
      jobs: ["index"],
    });
  });

  it("re-POST with same (source, external_id) updates in place (no duplicate row)", async () => {
    const first = await apiWithQueue("/api/memory/documents", {
      method: "POST",
      body: { title: "V1", source: "notion", text: "first text", external_id: "pg" },
    });
    const firstBody = (await first.res.json()) as { id: string };

    const second = await apiWithQueue("/api/memory/documents", {
      method: "POST",
      body: { title: "V2", source: "notion", text: "second text", external_id: "pg" },
    });
    expect(second.res.status).toBe(202);
    const secondBody = (await second.res.json()) as { id: string };
    expect(secondBody.id).toBe(firstBody.id); // same document

    const rows = await env.DB.prepare(
      "SELECT title, text, revision FROM memory_documents WHERE user_id = ? AND source = 'notion' AND external_id = 'pg'",
    )
      .bind(SINGLE_USER_ID)
      .all<{ title: string; text: string; revision: number }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].title).toBe("V2");
    expect(rows.results[0].text).toBe("second text");
    expect(rows.results[0].revision).toBe(2);
    expect(second.sent[0].sourceRevision).toBe(2);
  });

  it("validates required fields", async () => {
    const { res } = await apiWithQueue("/api/memory/documents", {
      method: "POST",
      body: { title: "no text or source" },
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/memory/documents/:id", () => {
  it("returns chunk_count 0 while queued, real count after consumer run", async () => {
    const { res } = await apiWithQueue("/api/memory/documents", {
      method: "POST",
      body: {
        title: "Doc",
        source: "upload",
        text: "Body of the uploaded document.",
        metadata: { url: "https://example.com/doc" },
      },
    });
    const { id } = (await res.json()) as { id: string };

    const before = await api(`/api/memory/documents/${id}`);
    expect(before.status).toBe(200);
    const beforeBody = (await before.json()) as { chunk_count: number; metadata?: { url?: string } };
    expect(beforeBody.chunk_count).toBe(0);
    expect(beforeBody.metadata?.url).toBe("https://example.com/doc");

    // Run the consumer job directly (simulates queue delivery).
    await ingestMemory(
      env,
      { userId: SINGLE_USER_ID, kind: "document", parentId: id, sourceRevision: 1 },
      { provider: new RecordingProvider(), index: new RecordingIndex() },
    );

    const after = await api(`/api/memory/documents/${id}`);
    const afterBody = (await after.json()) as { chunk_count: number };
    expect(afterBody.chunk_count).toBeGreaterThan(0);
  });

  it("404s for a missing document", async () => {
    const res = await api(`/api/memory/documents/${crypto.randomUUID()}`);
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/memory/documents/:id", () => {
  it("removes the document, its chunks, and its vectors", async () => {
    const { res } = await apiWithQueue("/api/memory/documents", {
      method: "POST",
      body: { title: "Doomed", source: "upload", text: "delete me soon please" },
    });
    const { id } = (await res.json()) as { id: string };
    await ingestMemory(
      env,
      { userId: SINGLE_USER_ID, kind: "document", parentId: id, sourceRevision: 1 },
      { provider: new RecordingProvider(), index: new RecordingIndex() },
    );
    expect(await chunkCount(id, "document")).toBe(1);

    const del = await api(`/api/memory/documents/${id}`, { method: "DELETE" });
    expect(del.status).toBe(204);
    expect(await chunkCount(id, "document")).toBe(0);
    const vec = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM memory_vectors_dev WHERE id LIKE ?",
    )
      .bind(`${id}:%`)
      .first<{ n: number }>();
    expect(vec?.n).toBe(0);
    const doc = await api(`/api/memory/documents/${id}`);
    expect(doc.status).toBe(404);
  });
});

describe("POST /api/memory/search (route)", () => {
  it("400 on empty query; 401 unauthenticated", async () => {
    const empty = await api("/api/memory/search", { method: "POST", body: { query: "  " } });
    expect(empty.status).toBe(400);
    const noAuth = await api("/api/memory/search", {
      method: "POST",
      body: { query: "x" },
      token: null,
    });
    expect(noAuth.status).toBe(401);
  });

  it("returns the same shape as a direct searchMemory() call", async () => {
    const sessionId = crypto.randomUUID();
    await seedSession(sessionId, { title: "Roadmap sync" });
    await seedSegments(sessionId, [
      { speaker: "1", text: "roadmap prioritization discussion for the fall release" },
    ]);
    await ingestMemory(
      env,
      { userId: SINGLE_USER_ID, kind: "transcript", parentId: sessionId, sourceRevision: 1 },
      { provider: new RecordingProvider(), index: new RecordingIndex() },
    );

    const res = await api("/api/memory/search", {
      method: "POST",
      body: { query: "roadmap prioritization", top_k: 5 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: {
        id: string;
        score: number;
        display_score: number;
        source: string;
        text: string;
        kind: string;
        session_id?: string;
        session_title?: string;
        created_at: number;
      }[];
      sessions: { id: string; title: string; created_at: number }[];
    };
    expect(Array.isArray(body.results)).toBe(true);
    expect(Array.isArray(body.sessions)).toBe(true);
    const hit = body.results.find((r) => r.session_id === sessionId);
    expect(hit).toBeDefined();
    expect(hit?.session_title).toBe("Roadmap sync");
    expect(body.results[0].display_score).toBe(1.0);
  });

  it("validates filters", async () => {
    const badKind = await api("/api/memory/search", {
      method: "POST",
      body: { query: "x", filters: { kind: ["bogus"] } },
    });
    expect(badKind.status).toBe(400);
    const badDate = await api("/api/memory/search", {
      method: "POST",
      body: { query: "x", filters: { date_from: "not-a-date" } },
    });
    expect(badDate.status).toBe(400);
  });
});

describe("POST /api/memory/reindex", () => {
  it("recreates chunks for a session with zero chunk rows", async () => {
    const sessionId = crypto.randomUUID();
    await seedSession(sessionId);
    await seedSegments(sessionId, [{ speaker: "1", text: "lost then found" }]);
    expect(await chunkCount(sessionId, "transcript")).toBe(0);

    const res = await api("/api/memory/reindex", {
      method: "POST",
      body: { session_id: sessionId },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reindexed: number };
    expect(body.reindexed).toBe(1);
    expect(await chunkCount(sessionId, "transcript")).toBe(1);
  });
});

describe("DELETE /api/sessions/:id memory propagation", () => {
  it("deleting a session removes chunks + vectors for both kinds", async () => {
    const sessionId = crypto.randomUUID();
    const now = Date.now();
    // Create via API so the route owns it end to end.
    const put = await api(`/api/sessions/${sessionId}`, {
      method: "PUT",
      body: {
        title: "To delete",
        source: "mic",
        status: "done",
        created_at: now,
        updated_at: now,
        duration_ms: 10,
      },
    });
    expect(put.status).toBe(201);
    await seedSegments(sessionId, [{ speaker: "1", text: "ephemeral words" }]);
    await env.DB.prepare(
      `INSERT INTO summaries (id, session_id, kind, payload_json, revision, created_at)
       VALUES (?, ?, 'meeting_summary', ?, 1, ?)`,
    )
      .bind(crypto.randomUUID(), sessionId, JSON.stringify({ overview: "gone soon" }), now)
      .run();
    const deps = { provider: new RecordingProvider(), index: new RecordingIndex() };
    await ingestMemory(env, { userId: SINGLE_USER_ID, kind: "transcript", parentId: sessionId, sourceRevision: 1 }, deps);
    await ingestMemory(env, { userId: SINGLE_USER_ID, kind: "summary", parentId: sessionId, sourceRevision: 1 }, deps);
    expect(await chunkCount(sessionId, "transcript")).toBe(1);
    expect(await chunkCount(sessionId, "summary")).toBe(1);

    const del = await api(`/api/sessions/${sessionId}`, { method: "DELETE" });
    expect(del.status).toBe(204);
    expect(await chunkCount(sessionId, "transcript")).toBe(0);
    expect(await chunkCount(sessionId, "summary")).toBe(0);
    const vec = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM memory_vectors_dev WHERE id LIKE ?",
    )
      .bind(`${sessionId}:%`)
      .first<{ n: number }>();
    expect(vec?.n).toBe(0);

    // Search finds nothing afterwards.
    const ctx = createExecutionContext();
    const req = new Request("https://example.com/api/memory/search", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-app-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: "ephemeral words" }),
    });
    const res = await worker.fetch(req, env as Env, ctx);
    await waitOnExecutionContext(ctx);
    const body = (await res.json()) as { results: { session_id?: string }[] };
    expect(body.results.every((r) => r.session_id !== sessionId)).toBe(true);
  });
});
