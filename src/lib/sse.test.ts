import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseSseEvent, postSse } from "./sse";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Build a streaming Response from raw SSE chunks. */
function sseResponse(chunks: string[], init: ResponseInit = {}): Response {
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
    ...init,
  });
}

function collect() {
  const deltas: string[] = [];
  let done: Record<string, unknown> | null = null;
  let error: { code: string; message: string } | null = null;
  return {
    deltas,
    get done() {
      return done;
    },
    get error() {
      return error;
    },
    callbacks: {
      onDelta: (t: string) => deltas.push(t),
      onDone: (extra: Record<string, unknown>) => {
        done = extra;
      },
      onError: (code: string, message: string) => {
        error = { code, message };
      },
    },
  };
}

describe("parseSseEvent", () => {
  it("parses delta / done / error events", () => {
    expect(parseSseEvent('data: {"delta":"hi"}')).toEqual({ delta: "hi" });
    expect(parseSseEvent('data: {"done":true}')).toEqual({ done: {} });
    expect(
      parseSseEvent('data: {"done":true,"sources":[{"session_id":"s1"}]}'),
    ).toEqual({ done: { sources: [{ session_id: "s1" }] } });
    expect(
      parseSseEvent('data: {"error":{"code":"ai_unavailable","message":"x"}}'),
    ).toEqual({ error: { code: "ai_unavailable", message: "x" } });
  });

  it("returns null for junk, comments, and non-data lines", () => {
    expect(parseSseEvent("")).toBeNull();
    expect(parseSseEvent(": keepalive")).toBeNull();
    expect(parseSseEvent("data: not-json")).toBeNull();
    expect(parseSseEvent('data: "just a string"')).toBeNull();
  });
});

describe("postSse", () => {
  it("streams deltas then fires onDone with extra fields", async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        'data: {"delta":"Hel"}\n\n',
        'data: {"delta":"lo"}\n\n',
        'data: {"done":true,"sources":[{"session_id":"s1","title":"T","snippet":"x"}]}\n\n',
      ]),
    );
    const c = collect();
    await postSse("/ask", { question: "q", scope: "all" }, c.callbacks);
    expect(c.deltas).toEqual(["Hel", "lo"]);
    expect(c.done).toEqual({
      sources: [{ session_id: "s1", title: "T", snippet: "x" }],
    });
    expect(c.error).toBeNull();
  });

  it("reassembles events split across chunk boundaries", async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        'data: {"del',
        'ta":"a"}\n',
        '\ndata: {"delta":"b"}\n\nda',
        'ta: {"done":true}\n\n',
      ]),
    );
    const c = collect();
    await postSse("/x", {}, c.callbacks);
    expect(c.deltas).toEqual(["a", "b"]);
    expect(c.done).toEqual({});
  });

  it("surfaces a mid-stream error event and stops", async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        'data: {"delta":"partial"}\n\n',
        'data: {"error":{"code":"ai_unavailable","message":"boom"}}\n\n',
      ]),
    );
    const c = collect();
    await postSse("/x", {}, c.callbacks);
    expect(c.deltas).toEqual(["partial"]);
    expect(c.done).toBeNull();
    expect(c.error).toEqual({ code: "ai_unavailable", message: "boom" });
  });

  it("maps non-2xx JSON error bodies through onError", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "transcript_not_ready", message: "not done" },
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
    );
    const c = collect();
    await postSse("/x", {}, c.callbacks);
    expect(c.error).toEqual({
      code: "transcript_not_ready",
      message: "not done",
    });
  });

  it("reports stream_ended when the stream closes without done", async () => {
    fetchMock.mockResolvedValue(sseResponse(['data: {"delta":"a"}\n\n']));
    const c = collect();
    await postSse("/x", {}, c.callbacks);
    expect(c.deltas).toEqual(["a"]);
    expect(c.error?.code).toBe("stream_ended");
  });

  it("reports network errors through onError", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const c = collect();
    await postSse("/x", {}, c.callbacks);
    expect(c.error?.code).toBe("network");
  });

  it("attaches the bearer token and JSON body", async () => {
    localStorage.setItem("lb.apiToken", "tok-1");
    fetchMock.mockResolvedValue(sseResponse(['data: {"done":true}\n\n']));
    const c = collect();
    await postSse("/ask", { question: "q", scope: "all" }, c.callbacks);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/ask");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer tok-1",
    );
    expect(init?.body).toBe(JSON.stringify({ question: "q", scope: "all" }));
  });

  it("stays silent when aborted by the caller", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(() => {
      controller.abort();
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    });
    const c = collect();
    await postSse("/x", {}, c.callbacks, { signal: controller.signal });
    expect(c.error).toBeNull();
    expect(c.done).toBeNull();
  });
});
