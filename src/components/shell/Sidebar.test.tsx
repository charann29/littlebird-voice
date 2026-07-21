/**
 * Sidebar tests — the Sessions nav counts must reflect the MERGED
 * local + server sessions index (unique ids), not only the locally cached
 * recordings, while the offline footer keeps describing the local cache.
 */
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Recording } from "../../types";
import type { SessionListItem } from "../../lib/mergeSessions";

function rec(id: string, over: Partial<Recording> = {}): Recording {
  return {
    id,
    title: null,
    createdAt: Date.now(),
    durationMs: 60_000,
    mimeType: "audio/webm",
    blobSize: 1,
    blob: new Blob(),
    status: "done",
    transcript: null,
    error: null,
    sonioxFileId: null,
    sonioxTranscriptionId: null,
    segments: null,
    syncState: "synced",
    ...over,
  };
}

function item(id: string, over: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id,
    title: `Session ${id}`,
    source: "mic",
    status: "done",
    createdAt: Date.now(),
    durationMs: 60_000,
    error: null,
    hasLocalAudio: true,
    isServerBacked: false,
    isServerOnly: false,
    hasSummary: false,
    ...over,
  };
}

const recordingsState: { recordings: Recording[] } = { recordings: [] };
vi.mock("../../hooks/useRecordings", () => ({
  useRecordings: () => ({
    recordings: recordingsState.recordings,
    stages: {},
    activeIds: [],
    refresh: vi.fn(),
    addFromBlob: vi.fn(),
    transcribeOne: vi.fn(),
    transcribeAllPending: vi.fn(),
    remove: vi.fn(),
  }),
}));

const indexState: { items: SessionListItem[]; pendingCount: number } = {
  items: [],
  pendingCount: 0,
};
vi.mock("../../hooks/useSessionsIndex", () => ({
  useSessionsIndex: () => ({
    items: indexState.items,
    dayGroups: [],
    pendingCount: indexState.pendingCount,
    isServerBacked: true,
  }),
}));

import { Sidebar } from "./Sidebar";

function renderSidebar() {
  return render(
    <MemoryRouter>
      <Sidebar />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  recordingsState.recordings = [];
  indexState.items = [];
  indexState.pendingCount = 0;
});

describe("Sidebar session counts", () => {
  it("shows the merged local+server total, not just cached recordings", () => {
    // 1 cached locally, but the merged index has 4 unique sessions
    // (1 local + 3 server-only).
    recordingsState.recordings = [rec("a")];
    indexState.items = [
      item("a"),
      item("b", { isServerOnly: true, hasLocalAudio: false }),
      item("c", { isServerOnly: true, hasLocalAudio: false }),
      item("d", { isServerOnly: true, hasLocalAudio: false }),
    ];
    renderSidebar();

    const sessionsLink = screen.getByRole("link", { name: /Sessions/ });
    expect(within(sessionsLink).getByText("4")).toBeInTheDocument();
  });

  it("shows the merged pending count badge", () => {
    indexState.items = [
      item("a", { status: "pending" }),
      item("b", { isServerOnly: true, hasLocalAudio: false, status: "pending" }),
      item("c"),
    ];
    indexState.pendingCount = 2;
    renderSidebar();

    const sessionsLink = screen.getByRole("link", { name: /Sessions/ });
    expect(within(sessionsLink).getByText("2")).toBeInTheDocument();
    expect(within(sessionsLink).getByText("3")).toBeInTheDocument();
  });

  it("hides the pending badge when nothing is pending", () => {
    indexState.items = [item("a")];
    renderSidebar();

    const sessionsLink = screen.getByRole("link", { name: /Sessions/ });
    const badges = within(sessionsLink)
      .getAllByText(/^\d+$/)
      .map((el) => el.textContent);
    expect(badges).toEqual(["1"]);
  });

  it("footer keeps describing the LOCAL cache count", () => {
    recordingsState.recordings = [rec("a"), rec("b")];
    indexState.items = [
      item("a"),
      item("b"),
      item("c", { isServerOnly: true, hasLocalAudio: false }),
    ];
    renderSidebar();

    expect(
      screen.getByText(/2 sessions cached on this device/),
    ).toBeInTheDocument();
  });

  it("footer falls back to generic copy with an empty local cache", () => {
    indexState.items = [item("s", { isServerOnly: true, hasLocalAudio: false })];
    renderSidebar();

    expect(
      screen.getByText("Capture works without a connection."),
    ).toBeInTheDocument();
  });
});
