/**
 * Shell + router tests (50-T1): right page per path, unknown-path redirect,
 * MVP-nav-only regression guard, active NavLink aria-current, capture
 * segmented control switching hosts, offline shell render.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Recording } from "../../types";

// The capture components pull in media/WebSocket machinery — stub them.
vi.mock("../LiveTranscription", () => ({
  LiveTranscription: () => <div data-testid="host-live">live-host</div>,
}));
vi.mock("../Recorder", () => ({
  Recorder: () => <div data-testid="host-recorder">recorder-host</div>,
}));
vi.mock("../MeetingCapture", () => ({
  MeetingCapture: () => <div data-testid="host-meeting">meeting-host</div>,
}));

// Recordings context — no IndexedDB in these tests.
const recordings: Recording[] = [];
vi.mock("../../hooks/useRecordings", () => ({
  useRecordings: () => ({
    recordings,
    stages: {},
    activeIds: [],
    refresh: vi.fn(),
    addFromBlob: vi.fn(),
    transcribeOne: vi.fn(),
    transcribeAllPending: vi.fn(),
    remove: vi.fn(),
  }),
}));

// OnlineBadge polls the sync outbox — stub the module.
vi.mock("../../lib/sync", () => ({
  getPendingOpCount: vi.fn(async () => 0),
  onOutboxSettled: () => () => {},
  drainOutbox: vi.fn(async () => {}),
}));

import { AppRoutes } from "../../router";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

function setOnline(value: boolean) {
  Object.defineProperty(navigator, "onLine", {
    value,
    configurable: true,
  });
}

beforeEach(() => {
  setOnline(true);
  window.localStorage.clear();
});

describe("route table", () => {
  it("index redirects to /sessions and renders the sessions page", () => {
    renderAt("/");
    expect(screen.getByRole("heading", { name: "Sessions" })).toBeInTheDocument();
    expect(
      screen.getByText(/No recordings yet\. Tap the mic above to record/),
    ).toBeInTheDocument();
  });

  it("unknown paths redirect to /sessions", () => {
    renderAt("/does/not/exist");
    expect(screen.getByRole("heading", { name: "Sessions" })).toBeInTheDocument();
  });

  it("/capture redirects to /capture/live", () => {
    renderAt("/capture");
    expect(screen.getByTestId("host-live")).toBeInTheDocument();
  });

  it("renders Ask AI, Settings, and Integrations pages", () => {
    const { unmount } = renderAt("/ask");
    expect(screen.getByRole("heading", { name: "Ask AI" })).toBeInTheDocument();
    unmount();

    const r2 = renderAt("/settings");
    expect(
      screen.getByRole("heading", { name: "Settings & Privacy" }),
    ).toBeInTheDocument();
    r2.unmount();

    renderAt("/settings/connections");
    expect(
      screen.getByRole("heading", { name: "Integrations" }),
    ).toBeInTheDocument();
  });
});

describe("sidebar (MVP nav regression guard)", () => {
  it("shows EXACTLY the 5 MVP entries: Capture, Sessions, Ask AI, Integrations, Settings & Privacy", () => {
    renderAt("/sessions");
    const rail = screen.getByRole("complementary");

    // Capture is a button; the rest are nav links.
    expect(within(rail).getByRole("button", { name: /Capture/ })).toBeInTheDocument();
    const links = within(rail).getAllByRole("link");
    const labels = links.map((l) => l.textContent);
    expect(labels).toHaveLength(4);
    expect(labels[0]).toContain("Sessions");
    expect(labels[1]).toContain("Ask AI");
    expect(labels[2]).toContain("Integrations");
    expect(labels[3]).toContain("Settings & Privacy");
  });

  it("marks the active NavLink with aria-current=page", () => {
    renderAt("/sessions");
    const rail = screen.getByRole("complementary");
    const sessions = within(rail).getByRole("link", { name: /Sessions/ });
    expect(sessions).toHaveAttribute("aria-current", "page");
    expect(
      within(rail).getByRole("link", { name: /Ask AI/ }),
    ).not.toHaveAttribute("aria-current");
  });

  it("navigating marks Settings & Privacy active without also marking Integrations", async () => {
    const user = userEvent.setup();
    renderAt("/settings");
    const rail = screen.getByRole("complementary");
    expect(
      within(rail).getByRole("link", { name: /Settings & Privacy/ }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      within(rail).getByRole("link", { name: /Integrations/ }),
    ).not.toHaveAttribute("aria-current");

    await user.click(within(rail).getByRole("link", { name: /Integrations/ }));
    expect(
      within(rail).getByRole("link", { name: /Integrations/ }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      within(rail).getByRole("link", { name: /Settings & Privacy/ }),
    ).not.toHaveAttribute("aria-current");
  });
});

describe("capture segmented control", () => {
  it("switches hosts between Live, Recorder, and Meeting", async () => {
    const user = userEvent.setup();
    renderAt("/capture/live");
    expect(screen.getByTestId("host-live")).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Recorder" }));
    expect(screen.getByTestId("host-recorder")).toBeInTheDocument();
    expect(screen.queryByTestId("host-live")).not.toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Meeting" }));
    expect(screen.getByTestId("host-meeting")).toBeInTheDocument();
    expect(screen.queryByTestId("host-recorder")).not.toBeInTheDocument();
  });
});

describe("offline shell", () => {
  it("renders the shell and sessions list offline (no fetch required)", () => {
    setOnline(false);
    renderAt("/sessions");
    expect(screen.getByRole("heading", { name: "Sessions" })).toBeInTheDocument();
    expect(screen.getByRole("complementary")).toBeInTheDocument();
  });
});

describe("mobile drawer", () => {
  it("opens via the hamburger, closes on Escape, and exposes a dialog", async () => {
    const user = userEvent.setup();
    renderAt("/sessions");

    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    const dialog = screen.getByRole("dialog", { name: "Navigation" });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: /Sessions/ })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("dialog", { name: "Navigation" }),
    ).not.toBeInTheDocument();
  });
});
