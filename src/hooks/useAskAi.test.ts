import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useAskAi } from "./useAskAi";
import { useFollowup } from "./useFollowup";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("useAskAi", () => {
  it("streams an answer into a history entry with sources", async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        'data: {"delta":"The answer"}\n\n',
        'data: {"delta":" is 42."}\n\n',
        'data: {"done":true,"sources":[{"session_id":"s1","title":"Standup","snippet":"…"}]}\n\n',
      ]),
    );
    const { result } = renderHook(() => useAskAi());
    act(() => result.current.ask("What is the answer?", "all"));
    expect(result.current.streaming).toBe(true);
    expect(result.current.entries).toHaveLength(1);

    await waitFor(() => expect(result.current.streaming).toBe(false));
    const entry = result.current.entries[0];
    expect(entry.status).toBe("done");
    expect(entry.answer).toBe("The answer is 42.");
    expect(entry.sources).toEqual([
      { session_id: "s1", title: "Standup", snippet: "…" },
    ]);
  });

  it("sends session_id for scope=session", async () => {
    fetchMock.mockResolvedValue(sseResponse(['data: {"done":true}\n\n']));
    const { result } = renderHook(() => useAskAi());
    act(() => result.current.ask("q", "session", "sess-9"));
    await waitFor(() => expect(result.current.streaming).toBe(false));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/ask");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      question: "q",
      scope: "session",
      session_id: "sess-9",
    });
  });

  it("records error entries and clears streaming", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: "ai_unavailable", message: "cap" } }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      ),
    );
    const { result } = renderHook(() => useAskAi());
    act(() => result.current.ask("q", "all"));
    await waitFor(() => expect(result.current.streaming).toBe(false));
    const entry = result.current.entries[0];
    expect(entry.status).toBe("error");
    expect(entry.errorCode).toBe("ai_unavailable");
  });

  it("ignores blank questions", () => {
    const { result } = renderHook(() => useAskAi());
    act(() => result.current.ask("   ", "all"));
    expect(result.current.entries).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("useFollowup", () => {
  it("streams the draft, then allows local edits", async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        'data: {"delta":"Subject: Hello\\n"}\n\n',
        'data: {"delta":"Body"}\n\n',
        'data: {"done":true}\n\n',
      ]),
    );
    const { result } = renderHook(() => useFollowup("s1"));
    expect(result.current.status).toBe("idle");
    act(() => result.current.generate("email", "keep it short"));
    expect(result.current.status).toBe("streaming");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.draft).toBe("Subject: Hello\nBody");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/sessions/s1/followup");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      format: "email",
      instructions: "keep it short",
    });

    act(() => result.current.setDraft("edited"));
    expect(result.current.draft).toBe("edited");
  });

  it("omits empty instructions from the body", async () => {
    fetchMock.mockResolvedValue(sseResponse(['data: {"done":true}\n\n']));
    const { result } = renderHook(() => useFollowup("s1"));
    act(() => result.current.generate("message", "   "));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(
      JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string),
    ).toEqual({ format: "message" });
  });

  it("surfaces stream errors with code", async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        'data: {"delta":"partial"}\n\n',
        'data: {"error":{"code":"ai_unavailable","message":"boom"}}\n\n',
      ]),
    );
    const { result } = renderHook(() => useFollowup("s1"));
    act(() => result.current.generate("email"));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.errorCode).toBe("ai_unavailable");
    expect(result.current.draft).toBe("partial");
  });
});
