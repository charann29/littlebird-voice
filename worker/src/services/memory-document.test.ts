/**
 * Unit tests for the internal memory-document ingestion service (the seam
 * shared by POST /api/memory/documents and the Notion import connector).
 * HTTP-level behavior stays covered by src/routes/memory.test.ts.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../env";
import { testEnv } from "../../test/helpers";
import { SINGLE_USER_ID } from "../auth";
import { ingestMemoryDocument } from "./memory-document";

const db = (env as unknown as Env).DB;

beforeEach(async () => {
  await db.prepare("DELETE FROM memory_documents").run();
});

describe("ingestMemoryDocument", () => {
  it("inserts a document row and enqueues an index-only ingest message", async () => {
    const { env: e, sent } = testEnv();
    const result = await ingestMemoryDocument(e, SINGLE_USER_ID, {
      title: "Doc",
      source: "notion",
      text: "Some text",
      external_id: "pg-1",
      metadata: { url: "https://notion.so/pg-1" },
    });
    expect(result.revision).toBe(1);

    const row = await db
      .prepare(
        "SELECT user_id, title, source, external_id, text, metadata_json, revision FROM memory_documents WHERE id = ?",
      )
      .bind(result.id)
      .first();
    expect(row).toEqual({
      user_id: SINGLE_USER_ID,
      title: "Doc",
      source: "notion",
      external_id: "pg-1",
      text: "Some text",
      metadata_json: JSON.stringify({ url: "https://notion.so/pg-1" }),
      revision: 1,
    });

    expect(sent).toEqual([
      {
        userId: SINGLE_USER_ID,
        kind: "document",
        parentId: result.id,
        sourceRevision: 1,
        jobs: ["index"],
      },
    ]);
  });

  it("is idempotent per (user_id, source, external_id): re-ingest updates and bumps revision", async () => {
    const { env: e, sent } = testEnv();
    const first = await ingestMemoryDocument(e, SINGLE_USER_ID, {
      title: "Doc v1",
      source: "notion",
      text: "old",
      external_id: "pg-1",
    });
    const second = await ingestMemoryDocument(e, SINGLE_USER_ID, {
      title: "Doc v2",
      source: "notion",
      text: "new",
      external_id: "pg-1",
    });
    expect(second.id).toBe(first.id);
    expect(second.revision).toBe(2);

    const count = await db
      .prepare("SELECT COUNT(*) AS n FROM memory_documents")
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
    expect(sent).toHaveLength(2);
    expect(sent[1].sourceRevision).toBe(2);
  });

  it("always inserts a new row when external_id is absent or blank", async () => {
    const { env: e } = testEnv();
    const a = await ingestMemoryDocument(e, SINGLE_USER_ID, {
      title: "One-off",
      source: "upload",
      text: "x",
    });
    const b = await ingestMemoryDocument(e, SINGLE_USER_ID, {
      title: "One-off",
      source: "upload",
      text: "x",
      external_id: "  ",
    });
    expect(a.id).not.toBe(b.id);
    const count = await db
      .prepare("SELECT COUNT(*) AS n FROM memory_documents")
      .first<{ n: number }>();
    expect(count?.n).toBe(2);
  });
});
