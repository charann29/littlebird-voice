/**
 * useSessionsIndex tests — the shared server-sessions store: N mounted hook
 * instances share ONE fetch (no duplicate requests), all instances see the
 * merged local+server list, and offline/no-token renders local-only without
 * touching the network.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Recording } from "../types";
import type { SessionMeta } from "../lib/api-types";

function rec(id: string, over: Partial<Recording> = {}): Recording {
  return {
    id,
    createdAt: 1_700_000_000_000,
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

function meta(id: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    user_id: "u1",
    title: `Server ${id}`,
    source: "mic",
    status: "done",
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    duration_ms: 60_000,
    mime_type: null,
    blob_size: null,
    self_speaker: null,
    transcript_revision: 0,
    error: null,
    ...over,
  };
}

const recordingsState: { recordings: Recording[] } = { recordings: [] };
vi.mock("./useRecordings", () => ({
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

vi.mock("./useOnlineStatus", () => ({
  useOnlineStatus: () => true,
}));

const apiState: { token: string | null; sessions: SessionMeta[] } = {
  token: "tok",
  sessions: [],
};
const apiFetchMock = vi.fn(async () => ({ sessions: apiState.sessions }));
vi.mock("../lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...(args as [])),
  getApiToken: () => apiState.token,
  onApiTokenChange: () => () => {},
}));

import {
  useSessionsIndex,
  __resetSessionsIndexStoreForTests,
} from "./useSessionsIndex";

function Probe({ label }: { label: string }) {
  const { items, pendingCount } = useSessionsIndex();
  return (
    <div>
      <span data-testid={`${label}-count`}>{items.length}</span>
      <span data-testid={`${label}-pending`}>{pendingCount}</span>
    </div>
  );
}

function setOnline(value: boolean) {
  Object.defineProperty(navigator, "onLine", { value, configurable: true });
}

beforeEach(() => {
  __resetSessionsIndexStoreForTests();
  recordingsState.recordings = [];
  apiState.token = "tok";
  apiState.sessions = [];
  apiFetchMock.mockClear();
  setOnline(true);
});

afterEach(() => {
  __resetSessionsIndexStoreForTests();
});

describe("useSessionsIndex shared store", () => {
  it("two mounted instances share ONE fetch and both see merged items", async () => {
    recordingsState.recordings = [rec("local-1")];
    apiState.sessions = [meta("srv-1"), meta("srv-2")];

    render(
      <>
        <Probe label="a" />
        <Probe label="b" />
      </>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("a-count").textContent).toBe("3");
      expect(screen.getByTestId("b-count").textContent).toBe("3");
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it("counts unique sessions: overlapping ids are merged, not doubled", async () => {
    recordingsState.recordings = [rec("both"), rec("local-only")];
    apiState.sessions = [meta("both"), meta("srv-only")];

    render(<Probe label="a" />);

    await waitFor(() => {
      expect(screen.getByTestId("a-count").textContent).toBe("3");
    });
  });

  it("pendingCount includes server-only pending rows", async () => {
    recordingsState.recordings = [rec("l1", { status: "pending" })];
    apiState.sessions = [meta("s1", { status: "pending" })];

    render(<Probe label="a" />);

    await waitFor(() => {
      expect(screen.getByTestId("a-pending").textContent).toBe("2");
    });
  });

  it("renders local-only without fetching when there is no token", () => {
    apiState.token = null;
    recordingsState.recordings = [rec("l1")];

    render(<Probe label="a" />);

    expect(screen.getByTestId("a-count").textContent).toBe("1");
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("renders local-only without fetching when offline", () => {
    setOnline(false);
    recordingsState.recordings = [rec("l1")];

    render(<Probe label="a" />);

    expect(screen.getByTestId("a-count").textContent).toBe("1");
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("a late-mounted instance reuses stored rows instead of refetching in flight", async () => {
    recordingsState.recordings = [];
    apiState.sessions = [meta("srv-1")];

    const first = render(<Probe label="a" />);
    await waitFor(() => {
      expect(screen.getByTestId("a-count").textContent).toBe("1");
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    // A second consumer mounting later hydrates instantly from the store;
    // its own effect re-fetches at most once more (fresh data on mount).
    first.unmount();
    render(<Probe label="b" />);
    expect(screen.getByTestId("b-count").textContent).toBe("1");
    await act(async () => {});
    expect(apiFetchMock.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
