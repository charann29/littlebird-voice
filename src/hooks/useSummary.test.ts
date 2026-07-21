import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useSummary } from "./useSummary";
import type { SummaryV1 } from "../lib/ai-types";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function summaryFixture(overrides: Partial<SummaryV1> = {}): SummaryV1 {
  return {
    version: 1,
    model: "mock-model",
    source_revision: 1,
    request_id: null,
    overview: "A meeting happened.",
    action_items: [],
    decisions: [],
    key_quotes: [],
    risks_open_questions: [],
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("useSummary", () => {
  it("loads a stored summary into ready state", async () => {
    fetchMock.mockResolvedValue(
      json({ summary: summaryFixture(), generated_at: 1234 }),
    );
    const { result } = renderHook(() => useSummary("s1"));
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.summary?.overview).toBe("A meeting happened.");
    expect(result.current.generatedAt).toBe(1234);
  });

  it("moves to idle on 404 no_summary", async () => {
    fetchMock.mockResolvedValue(
      json({ error: { code: "no_summary", message: "none" } }, 404),
    );
    const { result } = renderHook(() => useSummary("s1"));
    await waitFor(() => expect(result.current.status).toBe("idle"));
    expect(result.current.summary).toBeNull();
  });

  it("surfaces other load failures as error with code", async () => {
    fetchMock.mockResolvedValue(
      json({ error: { code: "not_found", message: "gone" } }, 404),
    );
    const { result } = renderHook(() => useSummary("s1"));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.errorCode).toBe("not_found");
  });

  it("generate() runs the synchronous summarize path", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ error: { code: "no_summary", message: "none" } }, 404),
    );
    const { result } = renderHook(() => useSummary("s1"));
    await waitFor(() => expect(result.current.status).toBe("idle"));

    fetchMock.mockResolvedValueOnce(
      json({ summary: summaryFixture({ overview: "Fresh." }) }),
    );
    act(() => result.current.generate());
    expect(result.current.status).toBe("generating");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.summary?.overview).toBe("Fresh.");
    const summarizeCall = fetchMock.mock.calls[1];
    expect(summarizeCall[0]).toBe("/api/sessions/s1/summarize");
    expect((summarizeCall[1] as RequestInit).method).toBe("POST");
  });

  it("generate() maps summarize errors to error state with code", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ error: { code: "no_summary", message: "none" } }, 404),
    );
    const { result } = renderHook(() => useSummary("s1"));
    await waitFor(() => expect(result.current.status).toBe("idle"));

    fetchMock.mockResolvedValueOnce(
      json(
        { error: { code: "transcript_not_ready", message: "not done" } },
        409,
      ),
    );
    act(() => result.current.generate());
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.errorCode).toBe("transcript_not_ready");
  });

  it("generate() polls after a 202 queued response until the summary lands", async () => {
    vi.useFakeTimers();
    // initial load: no summary
    fetchMock.mockResolvedValueOnce(
      json({ error: { code: "no_summary", message: "none" } }, 404),
    );
    const { result } = renderHook(() => useSummary("s1"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status).toBe("idle");

    // summarize → 202 queued; first poll → still none; second → ready
    fetchMock
      .mockResolvedValueOnce(json({ status: "queued" }, 202))
      .mockResolvedValueOnce(
        json({ error: { code: "no_summary", message: "none" } }, 404),
      )
      .mockResolvedValueOnce(
        json({
          summary: summaryFixture({ overview: "Queued result." }),
          generated_at: 99,
        }),
      );

    act(() => result.current.generate());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status).toBe("generating");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500); // poll 1 → no_summary
      await vi.advanceTimersByTimeAsync(2500); // poll 2 → summary
    });
    expect(result.current.status).toBe("ready");
    expect(result.current.summary?.overview).toBe("Queued result.");
    expect(result.current.generatedAt).toBe(99);
  });
});
