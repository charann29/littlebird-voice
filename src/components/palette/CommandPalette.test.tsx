/**
 * CommandPalette tests (50-T4): ⌘K/Ctrl-K open with preventDefault, Esc/scrim
 * close + focus restore, arrows/Home/End move aria-activedescendant, Enter
 * navigation (session / ask), relevance bars keyed on display_score (never
 * the raw RRF score), offline connectivity note, combobox/listbox roles,
 * Tab focus trap.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionListItem } from "../../lib/mergeSessions";
import type { MemorySearchState } from "./memorySearchAdapter";

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

const sessionsIndex: { items: SessionListItem[] } = { items: [] };
vi.mock("../../hooks/useSessionsIndex", () => ({
  useSessionsIndex: () => ({
    items: sessionsIndex.items,
    dayGroups: [],
    pendingCount: 0,
    isServerBacked: false,
  }),
}));

vi.mock("../../hooks/useRecordings", () => ({
  useRecordings: () => ({ recordings: [] }),
}));

const onlineState = { online: true };
vi.mock("../../hooks/useOnlineStatus", () => ({
  useOnlineStatus: () => onlineState.online,
}));

const memoryState: MemorySearchState = {
  results: [],
  sessions: [],
  isLoading: false,
  disabled: true,
};
vi.mock("./memorySearchAdapter", () => ({
  useMemorySearchAdapter: () => memoryState,
}));

import { CommandPalette } from "./CommandPalette";
import { CommandPaletteProvider } from "./useCommandPalette";

let lastLocation: ReturnType<typeof useLocation> | null = null;
function LocationSpy() {
  lastLocation = useLocation();
  return null;
}

function renderPalette(initialPath = "/sessions") {
  lastLocation = null;
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <CommandPaletteProvider>
        <button type="button">trigger</button>
        <CommandPalette />
        <LocationSpy />
      </CommandPaletteProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  // jsdom lacks scrollIntoView (palette keeps the selected row visible).
  Element.prototype.scrollIntoView = vi.fn();
  sessionsIndex.items = [];
  onlineState.online = true;
  memoryState.results = [];
  memoryState.sessions = [];
  memoryState.isLoading = false;
  memoryState.disabled = true;
});

describe("open/close", () => {
  it("opens on ⌘K and Ctrl-K with preventDefault, toggles closed", () => {
    renderPalette();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    const metaK = fireEvent.keyDown(window, { key: "k", metaKey: true });
    // fireEvent returns false when preventDefault was called.
    expect(metaK).toBe(false);
    expect(
      screen.getByRole("dialog", { name: "Search and ask AI" }),
    ).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    const ctrlK = fireEvent.keyDown(window, { key: "K", ctrlKey: true });
    expect(ctrlK).toBe(false);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("closes on Escape and restores focus to the trigger", async () => {
    const user = userEvent.setup();
    renderPalette();
    const trigger = screen.getByRole("button", { name: "trigger" });
    trigger.focus();

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const input = screen.getByRole("combobox");
    expect(input).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("closes on scrim click", async () => {
    const user = userEvent.setup();
    renderPalette();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await user.click(screen.getByTestId("palette-scrim"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Tab keeps focus on the input (focus trap)", async () => {
    const user = userEvent.setup();
    renderPalette();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const input = screen.getByRole("combobox");
    expect(input).toHaveFocus();
    await user.tab();
    expect(input).toHaveFocus();
  });
});

describe("combobox semantics + selection", () => {
  it("exposes combobox/listbox roles and moves aria-activedescendant with arrows/Home/End", async () => {
    const user = userEvent.setup();
    sessionsIndex.items = [session("a"), session("b"), session("c")];
    renderPalette();
    fireEvent.keyDown(window, { key: "k", metaKey: true });

    const input = screen.getByRole("combobox");
    expect(input).toHaveAttribute("aria-controls", "palette-results");
    expect(screen.getByRole("listbox")).toHaveAttribute("id", "palette-results");
    // Empty query → 3 recent sessions + 5 nav actions.
    const options = screen.getAllByRole("option");
    expect(options.length).toBe(8);
    expect(input).toHaveAttribute("aria-activedescendant", "palette-item-0");
    expect(options[0]).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{ArrowDown}");
    expect(input).toHaveAttribute("aria-activedescendant", "palette-item-1");
    await user.keyboard("{ArrowUp}{ArrowUp}");
    // Wraps from 0 to the last item.
    expect(input).toHaveAttribute(
      "aria-activedescendant",
      `palette-item-${options.length - 1}`,
    );
    await user.keyboard("{Home}");
    expect(input).toHaveAttribute("aria-activedescendant", "palette-item-0");
    await user.keyboard("{End}");
    expect(input).toHaveAttribute(
      "aria-activedescendant",
      `palette-item-${options.length - 1}`,
    );
  });

  it("Enter on a session navigates to /sessions/:id", async () => {
    const user = userEvent.setup();
    sessionsIndex.items = [session("abc-123")];
    renderPalette();
    fireEvent.keyDown(window, { key: "k", metaKey: true });

    // First item of the empty-query state is the most recent session.
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(lastLocation?.pathname).toBe("/sessions/abc-123");
  });

  it("Enter on Ask AI navigates to /ask?q=… (URL-encoded)", async () => {
    const user = userEvent.setup();
    renderPalette();
    fireEvent.keyDown(window, { key: "k", metaKey: true });

    await user.keyboard("what did we decide?");
    // Ask AI is the first group → index 0.
    await user.keyboard("{Enter}");
    expect(lastLocation?.pathname).toBe("/ask");
    expect(lastLocation?.search).toBe(
      `?q=${encodeURIComponent("what did we decide?")}`,
    );
  });

  it("Enter on a memory result navigates to the session with highlight state", async () => {
    const user = userEvent.setup();
    memoryState.disabled = false;
    memoryState.results = [
      {
        id: "chunk-1",
        session_id: "sess-9",
        score: 0.031,
        display_score: 1,
        text: "we agreed to ship Friday",
        start_ms: 120_000,
      },
    ];
    renderPalette();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await user.keyboard("ship");

    await user.keyboard("{ArrowDown}{Enter}"); // Ask → Memory result
    expect(lastLocation?.pathname).toBe("/sessions/sess-9");
    expect(lastLocation?.state).toEqual({ highlight: { start_ms: 120_000 } });
  });
});

describe("relevance bars", () => {
  it("derives width and printed value from display_score, never the raw score", async () => {
    const user = userEvent.setup();
    memoryState.disabled = false;
    memoryState.results = [
      {
        id: "top",
        session_id: "s1",
        score: 0.032, // raw RRF — must NOT drive the bar
        display_score: 1,
        text: "top match",
      },
      {
        id: "mid",
        session_id: "s2",
        score: 0.018,
        display_score: 0.56,
        text: "middling match",
      },
    ];
    renderPalette();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await user.keyboard("match");

    const top = screen.getByTestId("relevance-top");
    expect(top).toHaveTextContent("1.00");
    expect(top.querySelector("i")).toHaveStyle({ width: "100%" });
    // hi styling at display_score >= 0.9
    expect(top.className).toContain("text-indigo-200");

    const mid = screen.getByTestId("relevance-mid");
    expect(mid).toHaveTextContent("0.56");
    expect(mid.querySelector("i")).toHaveStyle({ width: "56.00000000000001%" });
    expect(mid.className).not.toContain("text-indigo-200");
    // Raw score must never be printed.
    expect(top).not.toHaveTextContent("0.03");
  });
});

describe("offline / disabled semantic search", () => {
  it("hides the Memory group and shows the connectivity note", async () => {
    const user = userEvent.setup();
    onlineState.online = false;
    memoryState.disabled = true;
    memoryState.results = [
      {
        id: "ghost",
        score: 0.03,
        display_score: 1,
        text: "should not render",
      },
    ];
    renderPalette();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await user.keyboard("anything");

    expect(screen.queryByTestId("relevance-ghost")).not.toBeInTheDocument();
    expect(screen.queryByText("Memory")).not.toBeInTheDocument();
    expect(
      screen.getByText(/Semantic search needs a connection/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/requires connection/),
    ).toBeInTheDocument();
  });
});

describe("contextual follow-up action", () => {
  it("appears only on a session detail route", () => {
    sessionsIndex.items = [session("cur", { title: "Design sync" })];
    renderPalette("/sessions/cur");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(
      screen.getByText("Draft follow-up for “Design sync”"),
    ).toBeInTheDocument();
  });

  it("does not appear on the list route", () => {
    sessionsIndex.items = [session("cur", { title: "Design sync" })];
    renderPalette("/sessions");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(
      screen.queryByText(/Draft follow-up for/),
    ).not.toBeInTheDocument();
  });
});
