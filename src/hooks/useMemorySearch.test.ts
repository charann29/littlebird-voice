import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMemorySearch, SEARCH_DEBOUNCE_MS } from "./useMemorySearch";
import type { MemorySearchResponse, MemorySearchResult } from "../types";

const fetchMock = vi.fn<typeof fetch>();

function makeResult(id: string, text: string): MemorySearchResult {
  return {
    id,
    score: 0.02,
    display_score: 1,
    source: "vector",
    text,
    kind: "transcript",
    session_id: "s-1",
    session_title: "Standup",
    created_at: 1700000000000,
  };
}

function okResponse(body: MemorySearchResponse): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

let onLine = true;

beforeEach(() => {
  vi.useFakeTimers();
  onLine = true;
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => onLine);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  localStorage.setItem("lb.apiToken", "test-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
});

/** Flush the debounce timer inside act(). */
async function flushDebounce(ms: number = SEARCH_DEBOUNCE_MS) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("useMemorySearch", () => {
  it("issues one POST /api/memory/search after the debounce and returns results", async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        results: [makeResult("c1", "hello world")],
        sessions: [{ id: "s-1", title: "Standup", created_at: 123 }],
      }),
    );

    const { result } = renderHook(() => useMemorySearch("hello"));
    expect(result.current.isLoading).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();

    await flushDebounce();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/memory/search");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ query: "hello" });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.results).toHaveLength(1);
    expect(result.current.results[0].text).toBe("hello world");
    expect(result.current.sessions).toEqual([
      { id: "s-1", title: "Standup", created_at: 123 },
    ]);
    expect(result.current.error).toBeNull();
    expect(result.current.disabled).toBe(false);
  });

  it("coalesces rapid input into a single request (debounce)", async () => {
    fetchMock.mockResolvedValue(okResponse({ results: [], sessions: [] }));

    const { rerender } = renderHook(({ q }) => useMemorySearch(q), {
      initialProps: { q: "h" },
    });
    await flushDebounce(100);
    rerender({ q: "he" });
    await flushDebounce(100);
    rerender({ q: "hel" });
    await flushDebounce(100);
    rerender({ q: "hello" });

    expect(fetchMock).not.toHaveBeenCalled();
    await flushDebounce();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init?.body as string).query).toBe("hello");
  });

  it("discards stale responses when the query changes mid-flight", async () => {
    // First request: resolves only when we say so — but its signal will be
    // aborted first, so its (late) result must be discarded.
    let resolveFirst!: (r: Response) => void;
    const firstSignalSeen: AbortSignal[] = [];
    fetchMock.mockImplementationOnce((_url, init) => {
      firstSignalSeen.push(init!.signal as AbortSignal);
      return new Promise<Response>((res) => {
        resolveFirst = res;
      });
    });
    fetchMock.mockResolvedValueOnce(
      okResponse({ results: [makeResult("c2", "fresh")], sessions: [] }),
    );

    const { result, rerender } = renderHook(({ q }) => useMemorySearch(q), {
      initialProps: { q: "first" },
    });
    await flushDebounce();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender({ q: "second" });
    expect(firstSignalSeen[0].aborted).toBe(true);

    await flushDebounce();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Late arrival of the stale response must not clobber the fresh one.
    await act(async () => {
      resolveFirst(
        okResponse({ results: [makeResult("c1", "stale")], sessions: [] }),
      );
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.results).toHaveLength(1);
    expect(result.current.results[0].text).toBe("fresh");
  });

  it("short-circuits when offline: no request, empty results, disabled=true", async () => {
    onLine = false;
    const { result } = renderHook(() => useMemorySearch("hello"));

    await flushDebounce();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.results).toEqual([]);
    expect(result.current.sessions).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.disabled).toBe(true);
  });

  it("does nothing for empty/whitespace queries", async () => {
    const { result } = renderHook(() => useMemorySearch("   "));
    await flushDebounce();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.results).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.disabled).toBe(false);
  });

  it("surfaces an error message on failed search and clears results", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "internal", message: "search exploded" },
        }),
        { status: 500 },
      ),
    );

    const { result } = renderHook(() => useMemorySearch("boom"));
    await flushDebounce();

    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBe("search exploded");
    expect(result.current.results).toEqual([]);
  });

  it("clears a previous error when a new query succeeds", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "x", message: "bad" } }), {
        status: 500,
      }),
    );
    fetchMock.mockResolvedValueOnce(
      okResponse({ results: [makeResult("c3", "ok now")], sessions: [] }),
    );

    const { result, rerender } = renderHook(({ q }) => useMemorySearch(q), {
      initialProps: { q: "boom" },
    });
    await flushDebounce();
    expect(result.current.error).toBe("bad");

    rerender({ q: "recover" });
    await flushDebounce();

    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.results[0].text).toBe("ok now");
  });

  it("passes filters through to the request body", async () => {
    fetchMock.mockResolvedValue(okResponse({ results: [], sessions: [] }));

    renderHook(() =>
      useMemorySearch("notes", { kind: ["summary"], session_id: "s-9" }),
    );
    await flushDebounce();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual({
      query: "notes",
      filters: { kind: ["summary"], session_id: "s-9" },
    });
  });

  it("aborts the in-flight request on unmount", async () => {
    const seenSignals: AbortSignal[] = [];
    fetchMock.mockImplementation((_url, init) => {
      seenSignals.push(init!.signal as AbortSignal);
      return new Promise<Response>(() => {
        /* never resolves */
      });
    });

    const { unmount } = renderHook(() => useMemorySearch("hello"));
    await flushDebounce();
    expect(seenSignals).toHaveLength(1);
    expect(seenSignals[0].aborted).toBe(false);

    unmount();
    expect(seenSignals[0].aborted).toBe(true);
  });
});
