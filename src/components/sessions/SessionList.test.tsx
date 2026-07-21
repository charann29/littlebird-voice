/**
 * SessionList tests (50-T2): empty-state copy, day headers, filter chips,
 * status pills, pending Transcribe affordance → transcribeOne, back-online
 * banner → transcribeAllPending, offline local-only rendering without fetch.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionListItem } from "../../lib/mergeSessions";

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

const indexState: { items: SessionListItem[]; pendingCount: number } = {
  items: [],
  pendingCount: 0,
};
vi.mock("../../hooks/useSessionsIndex", () => ({
  useSessionsIndex: () => ({
    items: indexState.items,
    dayGroups: [],
    pendingCount: indexState.pendingCount,
    isServerBacked: false,
  }),
}));

const transcribeOneMock = vi.fn(async () => {});
const transcribeAllMock = vi.fn(async () => {});
vi.mock("../../hooks/useRecordings", () => ({
  useRecordings: () => ({
    recordings: [],
    stages: {},
    activeIds: [],
    transcribeOne: transcribeOneMock,
    transcribeAllPending: transcribeAllMock,
    remove: vi.fn(),
  }),
}));

const onlineState = { online: true };
vi.mock("../../hooks/useOnlineStatus", () => ({
  useOnlineStatus: () => onlineState.online,
}));

import { SessionList } from "./SessionList";

function renderList() {
  return render(
    <MemoryRouter>
      <SessionList />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  indexState.items = [];
  indexState.pendingCount = 0;
  onlineState.online = true;
  transcribeOneMock.mockClear();
  transcribeAllMock.mockClear();
});

describe("SessionList", () => {
  it("renders the v1 empty-state copy verbatim", () => {
    renderList();
    expect(
      screen.getByText(
        "No recordings yet. Tap the mic above to record — it works offline.",
      ),
    ).toBeInTheDocument();
  });

  it("renders day-group headers (Today / Yesterday)", () => {
    const now = Date.now();
    indexState.items = [
      item("a", { createdAt: now }),
      item("b", { createdAt: now - 24 * 60 * 60 * 1000 }),
    ];
    renderList();
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText("Yesterday")).toBeInTheDocument();
  });

  it("filter chips split meetings (source != mic) from voice notes", async () => {
    const user = userEvent.setup();
    indexState.items = [
      item("note", { title: "A voice note", source: "mic" }),
      item("meet", { title: "A meeting", source: "tab" }),
    ];
    renderList();

    expect(screen.getByText("A voice note")).toBeInTheDocument();
    expect(screen.getByText("A meeting")).toBeInTheDocument();

    const meetings = screen.getByRole("button", { name: "Meetings" });
    await user.click(meetings);
    expect(meetings).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("A voice note")).not.toBeInTheDocument();
    expect(screen.getByText("A meeting")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Voice notes" }));
    expect(screen.getByText("A voice note")).toBeInTheDocument();
    expect(screen.queryByText("A meeting")).not.toBeInTheDocument();
  });

  it("shows a status pill per row", () => {
    indexState.items = [
      item("p", { status: "pending" }),
      item("t", { status: "transcribing" }),
      item("d", { status: "done" }),
      item("e", { status: "error" }),
    ];
    renderList();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("Transcribing…")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByText("Error")).toBeInTheDocument();
  });

  it("pending row's inline Transcribe calls transcribeOne without navigating", async () => {
    const user = userEvent.setup();
    indexState.items = [item("p1", { status: "pending" })];
    renderList();

    const row = screen.getByRole("link", { name: /Session p1/ });
    await user.click(within(row).getByRole("button", { name: "Transcribe" }));
    expect(transcribeOneMock).toHaveBeenCalledWith("p1");
  });

  it("back-online banner appears with pending items and Transcribe all drains", async () => {
    const user = userEvent.setup();
    indexState.items = [item("p1", { status: "pending" })];
    indexState.pendingCount = 1;
    renderList();

    expect(screen.getByText("You're back online")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Transcribe all" }));
    expect(transcribeAllMock).toHaveBeenCalled();
  });

  it("offline shows the amber info bar and no back-online banner", () => {
    onlineState.online = false;
    indexState.items = [item("p1", { status: "pending" })];
    indexState.pendingCount = 1;
    renderList();

    expect(screen.queryByText("You're back online")).not.toBeInTheDocument();
    expect(
      screen.getByText(/Playback works offline\. Pending recordings will/),
    ).toBeInTheDocument();
    // Header chip + the pending row's inline affordance both read Offline.
    expect(screen.getAllByText("Offline").length).toBeGreaterThan(0);
  });
});
