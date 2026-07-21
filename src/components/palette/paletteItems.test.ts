import { describe, expect, it } from "vitest";
import {
  buildPaletteGroups,
  flattenPaletteGroups,
  movePaletteIndex,
  type MemoryResultLike,
  type PaletteInput,
} from "./paletteItems";
import type { SessionListItem } from "../../lib/mergeSessions";

function session(id: string, over: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id,
    title: `Session ${id}`,
    source: "mic",
    status: "done",
    createdAt: 1_700_000_000_000,
    durationMs: 60_000,
    error: null,
    hasLocalAudio: true,
    isServerBacked: false,
    isServerOnly: false,
    hasSummary: false,
    ...over,
  };
}

function memory(id: string, over: Partial<MemoryResultLike> = {}): MemoryResultLike {
  return { id, score: 0.03, display_score: 1, text: `chunk ${id}`, ...over };
}

function input(over: Partial<PaletteInput> = {}): PaletteInput {
  return {
    query: "",
    memoryResults: [],
    sessionMatches: [],
    recentSessions: [],
    currentSession: null,
    ...over,
  };
}

describe("buildPaletteGroups", () => {
  it("orders groups Ask AI → Memory → Sessions → Actions for a query", () => {
    const groups = buildPaletteGroups(
      input({
        query: "sync",
        memoryResults: [memory("m1")],
        sessionMatches: [session("a")],
      }),
    );
    expect(groups.map((g) => g.label)).toEqual([
      "Ask AI",
      "Memory",
      "Sessions",
    ]);
    expect(groups[0].items[0]).toMatchObject({ kind: "ask", query: "sync" });
  });

  it("omits empty groups", () => {
    const groups = buildPaletteGroups(input({ query: "zzz-no-match" }));
    expect(groups.map((g) => g.label)).toEqual(["Ask AI"]);
  });

  it("empty query composes Recent sessions (max 5) + Actions, no Memory/Ask", () => {
    const recents = [
      session("1"),
      session("2"),
      session("3"),
      session("4"),
      session("5"),
      session("6"),
    ];
    const groups = buildPaletteGroups(
      input({ recentSessions: recents, memoryResults: [memory("m1")] }),
    );
    expect(groups.map((g) => g.label)).toEqual(["Recent sessions", "Actions"]);
    expect(groups[0].items).toHaveLength(5);
    expect(groups[0].items.map((i) => i.id)).toEqual([
      "session-1",
      "session-2",
      "session-3",
      "session-4",
      "session-5",
    ]);
  });

  it("adds the contextual follow-up action only when a current session is set", () => {
    const without = buildPaletteGroups(input({}));
    expect(
      flattenPaletteGroups(without).some((i) => i.id === "action-followup"),
    ).toBe(false);

    const withCtx = buildPaletteGroups(
      input({ currentSession: { id: "abc", title: "Design sync" } }),
    );
    const followUp = flattenPaletteGroups(withCtx).find(
      (i) => i.id === "action-followup",
    );
    expect(followUp).toMatchObject({
      kind: "action",
      label: "Draft follow-up for “Design sync”",
      to: "/sessions/abc",
      state: { tab: "followups" },
    });
  });

  it("filters nav actions by prefix, including the stripped 'go to ' form", () => {
    const groups = buildPaletteGroups(input({ query: "sess" }));
    const actions = groups.find((g) => g.label === "Actions");
    expect(actions?.items.map((i) => (i.kind === "action" ? i.label : ""))).toEqual([
      "Go to Sessions",
    ]);
  });
});

describe("flattenPaletteGroups", () => {
  it("preserves group order in the flat list", () => {
    const groups = buildPaletteGroups(
      input({
        query: "s",
        memoryResults: [memory("m1")],
        sessionMatches: [session("a")],
      }),
    );
    const flat = flattenPaletteGroups(groups);
    expect(flat[0].kind).toBe("ask");
    expect(flat[1].kind).toBe("memory");
    expect(flat[2].kind).toBe("session");
  });
});

describe("movePaletteIndex", () => {
  it("wraps around in both directions", () => {
    expect(movePaletteIndex(2, 1, 3)).toBe(0);
    expect(movePaletteIndex(0, -1, 3)).toBe(2);
    expect(movePaletteIndex(1, 1, 3)).toBe(2);
  });

  it("handles empty lists and unset selection", () => {
    expect(movePaletteIndex(0, 1, 0)).toBe(-1);
    expect(movePaletteIndex(-1, 1, 3)).toBe(0);
    expect(movePaletteIndex(-1, -1, 3)).toBe(2);
  });
});
