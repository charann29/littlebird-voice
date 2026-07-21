/**
 * SessionDetailPage tests (50-T3): not-found state, delete confirm calls
 * remove() and navigates back to /sessions, copy produces speaker-labelled
 * plain text.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Recording } from "../types";
import type { SessionDetail } from "../hooks/useSessionDetail";

function recording(over: Partial<Recording> = {}): Recording {
  return {
    id: "rec-1",
    title: null,
    createdAt: 1_700_000_000_000,
    durationMs: 61_000,
    mimeType: "audio/webm",
    blobSize: 3,
    blob: new Blob(["abc"]),
    status: "done",
    transcript: null,
    error: null,
    sonioxFileId: null,
    sonioxTranscriptionId: null,
    segments: [
      { speaker: "1", start_ms: 0, end_ms: 3000, text: "hello there" },
      { speaker: "2", start_ms: 3000, end_ms: 6000, text: "hi back" },
    ],
    syncState: "local",
    ...over,
  };
}

const detailState: { value: SessionDetail } = {
  value: {
    local: null,
    server: null,
    localLoaded: true,
    serverSettled: true,
    notFound: true,
    refreshLocal: vi.fn(async () => {}),
  },
};
vi.mock("../hooks/useSessionDetail", () => ({
  useSessionDetail: () => detailState.value,
}));

const removeMock = vi.fn(async () => {});
const renameMock = vi.fn(async () => {});
const recordingsState: { recordings: Recording[] } = { recordings: [] };
vi.mock("../hooks/useRecordings", () => ({
  useRecordings: () => ({
    recordings: recordingsState.recordings,
    stages: {},
    activeIds: [],
    transcribeOne: vi.fn(),
    transcribeAllPending: vi.fn(),
    remove: removeMock,
    rename: renameMock,
  }),
}));

import { SessionDetailPage } from "./SessionDetailPage";

let lastPathname = "";
function LocationSpy() {
  lastPathname = useLocation().pathname;
  return null;
}

function renderAt(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/sessions/${id}`]}>
      <Routes>
        <Route path="/sessions" element={<div>list page</div>} />
        <Route path="/sessions/:id" element={<SessionDetailPage />} />
      </Routes>
      <LocationSpy />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  removeMock.mockClear();
  renameMock.mockClear();
  recordingsState.recordings = [];
  detailState.value = {
    local: null,
    server: null,
    localLoaded: true,
    serverSettled: true,
    notFound: true,
    refreshLocal: vi.fn(async () => {}),
  };
  window.localStorage.clear();
});

describe("SessionDetailPage", () => {
  it("shows the not-found state when neither local nor server rows exist", () => {
    renderAt("nope");
    expect(screen.getByText("Session not found")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Back to Sessions" }),
    ).toBeInTheDocument();
  });

  it("renders a local session with transcript and audio player", () => {
    const rec = recording();
    recordingsState.recordings = [rec];
    detailState.value = { ...detailState.value, local: rec, notFound: false };
    renderAt("rec-1");

    expect(screen.getByText("hello there")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
  });

  it("copy produces speaker-labelled plain text", async () => {
    const user = userEvent.setup();
    const rec = recording();
    recordingsState.recordings = [rec];
    detailState.value = { ...detailState.value, local: rec, notFound: false };
    renderAt("rec-1");

    await user.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument(),
    );
    await expect(navigator.clipboard.readText()).resolves.toBe(
      "Speaker 1: hello there\nSpeaker 2: hi back",
    );
  });

  it("delete requires confirm, calls remove(id), and navigates to /sessions", async () => {
    const user = userEvent.setup();
    const rec = recording();
    recordingsState.recordings = [rec];
    detailState.value = { ...detailState.value, local: rec, notFound: false };
    renderAt("rec-1");

    await user.click(screen.getByRole("button", { name: "Delete session" }));
    expect(removeMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith("rec-1"));
    expect(lastPathname).toBe("/sessions");
    expect(screen.getByText("list page")).toBeInTheDocument();
  });

  it("cancel keeps the session and does not delete", async () => {
    const user = userEvent.setup();
    const rec = recording();
    recordingsState.recordings = [rec];
    detailState.value = { ...detailState.value, local: rec, notFound: false };
    renderAt("rec-1");

    await user.click(screen.getByRole("button", { name: "Delete session" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(removeMock).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Delete session" }),
    ).toBeInTheDocument();
  });

  it("renaming a local session calls rename() (durable IndexedDB + sync)", async () => {
    const user = userEvent.setup();
    const rec = recording();
    recordingsState.recordings = [rec];
    detailState.value = { ...detailState.value, local: rec, notFound: false };
    renderAt("rec-1");

    await user.click(screen.getByRole("button", { name: /Voice note/ }));
    const input = screen.getByRole("textbox", { name: "Session title" });
    await user.clear(input);
    await user.type(input, "My meeting{Enter}");

    await waitFor(() =>
      expect(renameMock).toHaveBeenCalledWith("rec-1", "My meeting"),
    );
    expect(screen.getByText("My meeting")).toBeInTheDocument();
  });

  it("shows the locally persisted title over the derived fallback", () => {
    const rec = recording({ title: "Persisted rename" });
    recordingsState.recordings = [rec];
    detailState.value = { ...detailState.value, local: rec, notFound: false };
    renderAt("rec-1");

    expect(screen.getByText("Persisted rename")).toBeInTheDocument();
  });

  it("server-only rows show the audio-stays-local note instead of a player", () => {
    detailState.value = {
      ...detailState.value,
      local: null,
      notFound: false,
      server: {
        session: {
          id: "srv-1",
          title: "Remote session",
          source: "tab",
          status: "done",
          created_at: 1_700_000_000_000,
          duration_ms: 30_000,
          updated_at: 1_700_000_000_000,
        },
        segments: [
          { seq: 0, speaker: "1", start_ms: 0, end_ms: 2000, text: "srv text" },
        ],
        summaries: [],
      } as never,
    };
    renderAt("srv-1");

    expect(screen.getByText("Remote session")).toBeInTheDocument();
    expect(
      screen.getByText("Audio stays on the device that recorded it."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Play" })).not.toBeInTheDocument();
    expect(screen.getByText("srv text")).toBeInTheDocument();
  });
});
