import { describe, expect, it } from "vitest";
import {
  defaultTitle,
  groupByDay,
  mergeSessions,
  type SessionListItem,
} from "./mergeSessions";
import type { Recording } from "../types";
import type { SessionMeta } from "./api-types";

function rec(overrides: Partial<Recording> & { id: string }): Recording {
  return {
    title: null,
    createdAt: Date.now(),
    durationMs: 60_000,
    mimeType: "audio/webm",
    blobSize: 100,
    blob: new Blob(["x"]),
    status: "pending",
    transcript: null,
    error: null,
    sonioxFileId: null,
    sonioxTranscriptionId: null,
    segments: null,
    syncState: "local",
    ...overrides,
  };
}

function meta(overrides: Partial<SessionMeta> & { id: string }): SessionMeta {
  return {
    user_id: "u1",
    title: "Server title",
    source: "tab",
    status: "done",
    created_at: Date.now(),
    updated_at: Date.now(),
    duration_ms: 120_000,
    mime_type: null,
    blob_size: null,
    self_speaker: null,
    transcript_revision: 1,
    error: null,
    ...overrides,
  };
}

describe("mergeSessions", () => {
  it("local wins for status/createdAt/duration/error; server contributes title/source", () => {
    const createdLocal = Date.parse("2026-07-20T10:00:00Z");
    const local = [
      rec({
        id: "a",
        status: "pending",
        createdAt: createdLocal,
        durationMs: 5_000,
        error: "boom",
      }),
    ];
    const server = [
      meta({
        id: "a",
        status: "done",
        created_at: Date.parse("2026-07-19T10:00:00Z"),
        duration_ms: 999,
        title: "Acme call",
        source: "tab",
        error: null,
      }),
    ];
    const [item] = mergeSessions(local, server);
    expect(item.status).toBe("pending");
    expect(item.createdAt).toBe(createdLocal);
    expect(item.durationMs).toBe(5_000);
    expect(item.error).toBe("boom");
    expect(item.title).toBe("Acme call");
    expect(item.source).toBe("tab");
    expect(item.hasLocalAudio).toBe(true);
    expect(item.isServerBacked).toBe(true);
    expect(item.isServerOnly).toBe(false);
  });

  it("server-only ids become read-only metadata rows", () => {
    const items = mergeSessions([], [meta({ id: "s1", title: "Remote" })]);
    expect(items).toHaveLength(1);
    expect(items[0].isServerOnly).toBe(true);
    expect(items[0].hasLocalAudio).toBe(false);
    expect(items[0].title).toBe("Remote");
  });

  it("a local rename wins over the server title", () => {
    const [item] = mergeSessions(
      [rec({ id: "a", title: "Local rename" })],
      [meta({ id: "a", title: "Server title" })],
    );
    expect(item.title).toBe("Local rename");
    // Without a local rename the server title still applies.
    const [fallback] = mergeSessions(
      [rec({ id: "b", title: null })],
      [meta({ id: "b", title: "Server title" })],
    );
    expect(fallback.title).toBe("Server title");
  });

  it("falls back to a derived title and mic source for local-only rows", () => {
    const createdAt = Date.parse("2026-07-18T09:30:00");
    const [item] = mergeSessions([rec({ id: "a", createdAt })], null);
    expect(item.title).toBe(defaultTitle(createdAt));
    expect(item.title).toMatch(/^Voice note — /);
    expect(item.source).toBe("mic");
    expect(item.isServerBacked).toBe(false);
  });

  it("server = null (offline / no token) yields local-only list", () => {
    const items = mergeSessions([rec({ id: "a" }), rec({ id: "b" })], null);
    expect(items).toHaveLength(2);
    expect(items.every((i) => !i.isServerBacked)).toBe(true);
  });

  it("dedupes by id and sorts createdAt desc", () => {
    const items = mergeSessions(
      [rec({ id: "a", createdAt: 1000 }), rec({ id: "b", createdAt: 3000 })],
      [meta({ id: "a" }), meta({ id: "c", created_at: 2000 })],
    );
    expect(items.map((i) => i.id)).toEqual(["b", "c", "a"]);
  });

  it("reads has_summary when the server provides it", () => {
    const withSummary = {
      ...meta({ id: "a" }),
      has_summary: true,
    } as SessionMeta;
    const [item] = mergeSessions([], [withSummary]);
    expect(item.hasSummary).toBe(true);
    const [plain] = mergeSessions([], [meta({ id: "b" })]);
    expect(plain.hasSummary).toBe(false);
  });
});

describe("groupByDay", () => {
  const now = new Date("2026-07-21T15:00:00").getTime();

  function item(id: string, createdAt: number): SessionListItem {
    return {
      id,
      title: id,
      source: "mic",
      status: "done",
      createdAt,
      durationMs: 0,
      error: null,
      hasLocalAudio: true,
      isServerBacked: false,
      isServerOnly: false,
      hasSummary: false,
    };
  }

  it("labels Today / Yesterday / weekday-date and respects midnight boundaries", () => {
    const today = new Date("2026-07-21T08:00:00").getTime();
    const justBeforeMidnight = new Date("2026-07-20T23:59:59").getTime();
    const friday = new Date("2026-07-17T12:00:00").getTime();
    const groups = groupByDay(
      [item("a", today), item("b", justBeforeMidnight), item("c", friday)],
      now,
    );
    expect(groups.map((g) => g.label)).toEqual([
      "Today",
      "Yesterday",
      expect.stringMatching(/^Friday/),
    ]);
    expect(groups[1].items.map((i) => i.id)).toEqual(["b"]);
  });

  it("groups multiple same-day items under one header", () => {
    const groups = groupByDay(
      [
        item("a", new Date("2026-07-21T10:00:00").getTime()),
        item("b", new Date("2026-07-21T08:00:00").getTime()),
      ],
      now,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(2);
  });
});
