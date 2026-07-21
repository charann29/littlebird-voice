import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { ingestMemory, deleteMemoryFor, reindexMemory } from "./ingest";
import type { IngestMessage } from "../services/ingest-message";
import {
  RecordingIndex,
  RecordingProvider,
  SINGLE_USER_ID,
  chunkCount,
  replaceSegments,
  seedSegments,
  seedSession,
} from "../../test/memory-helpers";

function msg(overrides: Partial<IngestMessage> & Pick<IngestMessage, "parentId">): IngestMessage {
  return {
    userId: SINGLE_USER_ID,
    kind: "transcript",
    sourceRevision: 1,
    ...overrides,
  };
}

describe("ingestMemory", () => {
  let provider: RecordingProvider;
  let index: RecordingIndex;
  let deps: { provider: RecordingProvider; index: RecordingIndex };

  beforeEach(() => {
    provider = new RecordingProvider();
    index = new RecordingIndex();
    deps = { provider, index };
  });

  it("chunks, embeds, and indexes a transcript (rows + vectors)", async () => {
    const sessionId = crypto.randomUUID();
    await seedSession(sessionId);
    await seedSegments(sessionId, [
      { speaker: "1", text: "Let us review the launch checklist for phoenix." },
      { speaker: "2", text: "The database migration is done and verified." },
    ]);

    const result = await ingestMemory(env, msg({ parentId: sessionId }), deps);
    expect(result).toEqual({ status: "ok", chunks: 1 });

    const rows = await env.DB.prepare(
      "SELECT id, kind, source_revision, embedded_at, embedding_model, content_hash FROM memory_chunks WHERE session_id = ?",
    )
      .bind(sessionId)
      .all<{ id: string; kind: string; source_revision: number; embedded_at: number | null; embedding_model: string | null; content_hash: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].id).toBe(`${sessionId}:transcript:0`);
    expect(rows.results[0].source_revision).toBe(1);
    expect(rows.results[0].embedded_at).not.toBeNull();
    expect(rows.results[0].embedding_model).toBe("test/mock-embedding");

    // Vector exists in the dev index under the user namespace.
    expect(index.upsertCalls).toEqual([
      { namespace: SINGLE_USER_ID, ids: [`${sessionId}:transcript:0`] },
    ]);
    const vec = await env.DB.prepare(
      "SELECT namespace FROM memory_vectors_dev WHERE id = ?",
    )
      .bind(`${sessionId}:transcript:0`)
      .first<{ namespace: string }>();
    expect(vec?.namespace).toBe(SINGLE_USER_ID);

    // FTS row is searchable via the triggers.
    const fts = await env.DB.prepare(
      `SELECT c.id FROM memory_chunks_fts JOIN memory_chunks c ON c.rowid = memory_chunks_fts.rowid
       WHERE memory_chunks_fts MATCH '"phoenix"'`,
    ).all<{ id: string }>();
    expect(fts.results.map((r) => r.id)).toContain(`${sessionId}:transcript:0`);
  });

  it("redelivered identical message re-embeds nothing (hash skip)", async () => {
    const sessionId = crypto.randomUUID();
    await seedSession(sessionId);
    await seedSegments(sessionId, [{ speaker: "1", text: "idempotency check" }]);

    await ingestMemory(env, msg({ parentId: sessionId }), deps);
    const embedsAfterFirst = provider.embeddedTextCount;
    const result = await ingestMemory(env, msg({ parentId: sessionId }), deps);
    expect(result).toEqual({ status: "ok", chunks: 1 });
    expect(provider.embeddedTextCount).toBe(embedsAfterFirst); // no new embeds
  });

  it("changed text at higher revision replaces chunks and deletes stale ids", async () => {
    const sessionId = crypto.randomUUID();
    await seedSession(sessionId);
    // Long transcript → several chunks.
    const many = Array.from({ length: 30 }, (_, i) => ({
      speaker: String((i % 2) + 1),
      text: `original take on agenda topic number ${i} with plenty of detail. `.repeat(3),
    }));
    await seedSegments(sessionId, many);
    await ingestMemory(env, msg({ parentId: sessionId, sourceRevision: 1 }), deps);
    const before = await chunkCount(sessionId, "transcript");
    expect(before).toBeGreaterThan(1);

    // Re-transcription: much shorter content, higher revision.
    await replaceSegments(sessionId, [{ speaker: "1", text: "short new transcript" }]);
    const result = await ingestMemory(
      env,
      msg({ parentId: sessionId, sourceRevision: 2 }),
      deps,
    );
    expect(result).toEqual({ status: "ok", chunks: 1 });
    expect(await chunkCount(sessionId, "transcript")).toBe(1);

    // Stale vector ids (chunk_index >= 1) were deleted from the index.
    const deleted = index.deleteCalls.flat();
    expect(deleted.length).toBe(before - 1);
    expect(deleted).toContain(`${sessionId}:transcript:1`);
    const staleVec = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM memory_vectors_dev WHERE id = ?",
    )
      .bind(`${sessionId}:transcript:1`)
      .first<{ n: number }>();
    expect(staleVec?.n).toBe(0);

    const row = await env.DB.prepare(
      "SELECT text, source_revision FROM memory_chunks WHERE id = ?",
    )
      .bind(`${sessionId}:transcript:0`)
      .first<{ text: string; source_revision: number }>();
    expect(row?.text).toContain("short new transcript");
    expect(row?.source_revision).toBe(2);
  });

  it("stale message (lower sourceRevision) is skipped; newer chunks untouched", async () => {
    const sessionId = crypto.randomUUID();
    await seedSession(sessionId);
    await seedSegments(sessionId, [{ speaker: "1", text: "revision five content" }]);
    await ingestMemory(env, msg({ parentId: sessionId, sourceRevision: 5 }), deps);

    const result = await ingestMemory(
      env,
      msg({ parentId: sessionId, sourceRevision: 3 }),
      deps,
    );
    expect(result).toEqual({ status: "skipped_stale" });

    const row = await env.DB.prepare(
      "SELECT text, source_revision FROM memory_chunks WHERE id = ?",
    )
      .bind(`${sessionId}:transcript:0`)
      .first<{ text: string; source_revision: number }>();
    expect(row?.source_revision).toBe(5);
    expect(row?.text).toContain("revision five content");
  });

  it("summary and transcript chunks coexist; re-ingesting one never touches the other", async () => {
    const sessionId = crypto.randomUUID();
    await seedSession(sessionId);
    await seedSegments(sessionId, [{ speaker: "1", text: "the transcript body" }]);
    await env.DB.prepare(
      `INSERT INTO summaries (id, session_id, kind, payload_json, revision, created_at)
       VALUES (?, ?, 'meeting_summary', ?, 1, ?)`,
    )
      .bind(crypto.randomUUID(), sessionId, JSON.stringify({ overview: "the summary body" }), Date.now())
      .run();

    await ingestMemory(env, msg({ parentId: sessionId, kind: "transcript" }), deps);
    await ingestMemory(env, msg({ parentId: sessionId, kind: "summary" }), deps);

    expect(await chunkCount(sessionId, "transcript")).toBe(1);
    expect(await chunkCount(sessionId, "summary")).toBe(1);

    // Distinct vector-ID kind segments.
    const ids = (
      await env.DB.prepare("SELECT id FROM memory_chunks WHERE session_id = ?")
        .bind(sessionId)
        .all<{ id: string }>()
    ).results.map((r) => r.id);
    expect(ids.sort()).toEqual(
      [`${sessionId}:summary:0`, `${sessionId}:transcript:0`].sort(),
    );

    // Re-ingest transcript at revision 2: summary chunk untouched.
    await replaceSegments(sessionId, [{ speaker: "1", text: "revised transcript" }]);
    await ingestMemory(
      env,
      msg({ parentId: sessionId, kind: "transcript", sourceRevision: 2 }),
      deps,
    );
    const summaryRow = await env.DB.prepare(
      "SELECT source_revision, text FROM memory_chunks WHERE id = ?",
    )
      .bind(`${sessionId}:summary:0`)
      .first<{ source_revision: number; text: string }>();
    expect(summaryRow?.source_revision).toBe(1);
    expect(summaryRow?.text).toContain("the summary body");
  });

  it("parent deleted before consumer ran → cleans leftovers, no throw", async () => {
    const result = await ingestMemory(
      env,
      msg({ parentId: crypto.randomUUID() }),
      deps,
    );
    expect(result).toEqual({ status: "parent_missing" });
  });

  it("document ingest persists chunk_count", async () => {
    const docId = crypto.randomUUID();
    const para = "Documented finding about the memory architecture choices. ".repeat(8).trim();
    await env.DB.prepare(
      `INSERT INTO memory_documents (id, user_id, title, source, text, revision, created_at, updated_at)
       VALUES (?, ?, 'Doc', 'upload', ?, 1, ?, ?)`,
    )
      .bind(docId, SINGLE_USER_ID, `${para}\n\n${para}\n\n${para}`, Date.now(), Date.now())
      .run();

    const result = await ingestMemory(
      env,
      msg({ parentId: docId, kind: "document" }),
      deps,
    );
    expect(result.status).toBe("ok");
    const doc = await env.DB.prepare(
      "SELECT chunk_count FROM memory_documents WHERE id = ?",
    )
      .bind(docId)
      .first<{ chunk_count: number }>();
    expect(doc?.chunk_count).toBe(await chunkCount(docId, "document"));
    expect(doc?.chunk_count).toBeGreaterThan(0);
  });

  it("embedding failure leaves rows with embedded_at NULL (keyword still works)", async () => {
    const sessionId = crypto.randomUUID();
    await seedSession(sessionId);
    await seedSegments(sessionId, [{ speaker: "1", text: "resilient zebra keyword" }]);

    const failing = {
      modelId: "fail/model",
      dimensions: 1024,
      embed: async () => {
        throw new Error("embedding backend down");
      },
    };
    await expect(
      ingestMemory(env, msg({ parentId: sessionId }), { provider: failing, index }),
    ).rejects.toThrow("embedding backend down");

    const row = await env.DB.prepare(
      "SELECT embedded_at FROM memory_chunks WHERE id = ?",
    )
      .bind(`${sessionId}:transcript:0`)
      .first<{ embedded_at: number | null }>();
    expect(row).not.toBeNull();
    expect(row?.embedded_at).toBeNull();

    // FTS keyword search still finds it.
    const fts = await env.DB.prepare(
      `SELECT c.id FROM memory_chunks_fts JOIN memory_chunks c ON c.rowid = memory_chunks_fts.rowid
       WHERE memory_chunks_fts MATCH '"zebra"'`,
    ).all<{ id: string }>();
    expect(fts.results.map((r) => r.id)).toContain(`${sessionId}:transcript:0`);
  });
});

describe("deleteMemoryFor", () => {
  it("removes rows for BOTH kinds and calls deleteByIds with the right ids", async () => {
    const sessionId = crypto.randomUUID();
    await seedSession(sessionId);
    await seedSegments(sessionId, [{ speaker: "1", text: "to be deleted" }]);
    await env.DB.prepare(
      `INSERT INTO summaries (id, session_id, kind, payload_json, revision, created_at)
       VALUES (?, ?, 'meeting_summary', ?, 1, ?)`,
    )
      .bind(crypto.randomUUID(), sessionId, JSON.stringify({ overview: "bye" }), Date.now())
      .run();

    const provider = new RecordingProvider();
    const index = new RecordingIndex();
    const deps = { provider, index };
    await ingestMemory(env, msg({ parentId: sessionId, kind: "transcript" }), deps);
    await ingestMemory(env, msg({ parentId: sessionId, kind: "summary" }), deps);

    const { deleted } = await deleteMemoryFor(env, { session_id: sessionId }, deps);
    expect(deleted).toBe(2);
    expect(index.deleteCalls.flat().sort()).toEqual(
      [`${sessionId}:summary:0`, `${sessionId}:transcript:0`].sort(),
    );
    expect(await chunkCount(sessionId, "transcript")).toBe(0);
    expect(await chunkCount(sessionId, "summary")).toBe(0);

    // FTS cleaned by triggers.
    const fts = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM memory_chunks_fts WHERE memory_chunks_fts MATCH '"deleted"'`,
    ).first<{ n: number }>();
    expect(fts?.n).toBe(0);
  });
});

describe("reindexMemory", () => {
  it("recreates chunks for a session with zero chunk rows", async () => {
    const sessionId = crypto.randomUUID();
    await seedSession(sessionId);
    await seedSegments(sessionId, [{ speaker: "1", text: "recovered content" }]);
    await env.DB.prepare(
      "UPDATE sessions SET transcript_revision = 4 WHERE id = ?",
    )
      .bind(sessionId)
      .run();

    expect(await chunkCount(sessionId, "transcript")).toBe(0);
    const provider = new RecordingProvider();
    const index = new RecordingIndex();
    const { reindexed } = await reindexMemory(env, SINGLE_USER_ID, sessionId, {
      provider,
      index,
    });
    expect(reindexed).toBe(1);
    expect(await chunkCount(sessionId, "transcript")).toBe(1);
    const row = await env.DB.prepare(
      "SELECT source_revision FROM memory_chunks WHERE id = ?",
    )
      .bind(`${sessionId}:transcript:0`)
      .first<{ source_revision: number }>();
    expect(row?.source_revision).toBe(4);
  });
});
