import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { SINGLE_USER_ID } from "../auth";
import {
  PersistenceError,
  saveSummary,
  saveTranscript,
} from "./persistence";
import { testEnv } from "../../test/helpers";

const OTHER_USER_ID = "00000000-0000-4000-8000-000000000002";

async function seedSession(id: string, userId = SINGLE_USER_ID): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(id, userId, now, now)
    .run();
}

beforeEach(async () => {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (id, email, name, created_at) VALUES (?, NULL, 'Other', 0)`,
  )
    .bind(OTHER_USER_ID)
    .run();
});

describe("saveTranscript", () => {
  it("replaces segments and bumps transcript_revision by exactly 1 per call", async () => {
    const { env: e } = testEnv();
    const id = crypto.randomUUID();
    await seedSession(id);

    const r1 = await saveTranscript(e, SINGLE_USER_ID, id, [
      { text: "a", speaker: "1", start_ms: 0, end_ms: 100 },
      { text: "b", speaker: "2", start_ms: 100, end_ms: 200 },
    ]);
    expect(r1).toEqual({ count: 2, revision: 1 });

    const r2 = await saveTranscript(e, SINGLE_USER_ID, id, [{ text: "c" }]);
    expect(r2).toEqual({ count: 1, revision: 2 });

    const rows = await env.DB.prepare(
      "SELECT seq, text FROM transcript_segments WHERE session_id = ? ORDER BY seq",
    )
      .bind(id)
      .all<{ seq: number; text: string }>();
    expect(rows.results).toEqual([{ seq: 0, text: "c" }]);

    const session = await env.DB.prepare(
      "SELECT transcript_revision FROM sessions WHERE id = ?",
    )
      .bind(id)
      .first<{ transcript_revision: number }>();
    expect(session?.transcript_revision).toBe(2);
  });

  it("publishes exactly one IngestMessage with sourceRevision = new counter", async () => {
    const { env: e, sent } = testEnv();
    const id = crypto.randomUUID();
    await seedSession(id);

    await saveTranscript(e, SINGLE_USER_ID, id, [{ text: "hello" }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      userId: SINGLE_USER_ID,
      kind: "transcript",
      parentId: id,
      sourceRevision: 1,
    });

    await saveTranscript(e, SINGLE_USER_ID, id, [{ text: "again" }]);
    expect(sent).toHaveLength(2);
    expect(sent[1].sourceRevision).toBe(2);
  });

  it("passes jobs/requestId through to the IngestMessage when provided", async () => {
    const { env: e, sent } = testEnv();
    const id = crypto.randomUUID();
    await seedSession(id);

    await saveTranscript(e, SINGLE_USER_ID, id, [{ text: "x" }], {
      jobs: ["summarize"],
      requestId: "req-1",
    });
    expect(sent[0].jobs).toEqual(["summarize"]);
    expect(sent[0].requestId).toBe("req-1");
  });

  it("rejects a sessionId owned by another user (not_found) and enqueues nothing", async () => {
    const { env: e, sent } = testEnv();
    const id = crypto.randomUUID();
    await seedSession(id, OTHER_USER_ID);

    await expect(
      saveTranscript(e, SINGLE_USER_ID, id, [{ text: "x" }]),
    ).rejects.toThrowError(PersistenceError);
    expect(sent).toHaveLength(0);
  });

  it("rejects a missing sessionId", async () => {
    const { env: e } = testEnv();
    await expect(
      saveTranscript(e, SINGLE_USER_ID, crypto.randomUUID(), [{ text: "x" }]),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("saveSummary", () => {
  it("upserts per (session, kind), bumping revision each time", async () => {
    const { env: e, sent } = testEnv();
    const id = crypto.randomUUID();
    await seedSession(id);

    const s1 = await saveSummary(e, SINGLE_USER_ID, id, "meeting_summary", {
      tl_dr: "v1",
    });
    expect(s1.revision).toBe(1);
    expect(s1.payload).toEqual({ tl_dr: "v1" });

    const s2 = await saveSummary(
      e,
      SINGLE_USER_ID,
      id,
      "meeting_summary",
      { tl_dr: "v2" },
      "model-x",
    );
    expect(s2.revision).toBe(2);
    expect(s2.id).toBe(s1.id); // same row, replaced payload
    expect(s2.model).toBe("model-x");

    // Independent kind → independent revision counter.
    const other = await saveSummary(e, SINGLE_USER_ID, id, "follow_ups", {});
    expect(other.revision).toBe(1);

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM summaries WHERE session_id = ?",
    )
      .bind(id)
      .first<{ n: number }>();
    expect(count?.n).toBe(2);

    // One message per save, each carrying the new revision.
    expect(sent.map((m) => [m.kind, m.sourceRevision])).toEqual([
      ["summary", 1],
      ["summary", 2],
      ["summary", 1],
    ]);
    expect(sent.every((m) => m.parentId === id)).toBe(true);
  });

  it("rejects a sessionId owned by another user", async () => {
    const { env: e, sent } = testEnv();
    const id = crypto.randomUUID();
    await seedSession(id, OTHER_USER_ID);

    await expect(
      saveSummary(e, SINGLE_USER_ID, id, "meeting_summary", {}),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(sent).toHaveLength(0);
  });
});
