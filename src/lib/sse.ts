/**
 * Fetch-based SSE reader for the section-20 streaming endpoints.
 *
 * Native `EventSource` can't POST or attach an Authorization header, so we
 * POST via fetch and hand-parse the `text/event-stream` body. Canonical
 * framing (worker/src/ai/stream.ts):
 *   data: {"delta":"..."}                        (repeated)
 *   data: {"done":true, ...extra e.g. sources}   (final)
 *   data: {"error":{"code","message"}}           (mid-stream failure → close)
 *
 * Non-2xx responses are JSON `{ error: { code, message } }` bodies, surfaced
 * through `onError` (not thrown), so callers have a single error channel.
 */

import { getApiToken } from "./api";

const API_BASE = "/api";

export interface SseCallbacks {
  onDelta: (text: string) => void;
  /** Extra fields from the final done event (e.g. `sources`). */
  onDone: (extra: Record<string, unknown>) => void;
  onError: (code: string, message: string) => void;
}

export interface SseRequestOptions {
  signal?: AbortSignal;
}

/**
 * Parse a full SSE `data:` payload line-set into the framing events. Exported
 * for tests. Feed it complete event blocks (text between blank-line breaks).
 */
export function parseSseEvent(
  block: string,
): { delta: string } | { done: Record<string, unknown> } | { error: { code: string; message: string } } | null {
  // An event block may span multiple lines; only `data:` lines carry payload.
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return null; // tolerate junk/keepalive events
  }
  if (payload === null || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;

  if (typeof obj.delta === "string") return { delta: obj.delta };
  if (obj.done === true) {
    const { done: _done, ...extra } = obj;
    return { done: extra };
  }
  if (obj.error !== null && typeof obj.error === "object") {
    const err = obj.error as Record<string, unknown>;
    return {
      error: {
        code: typeof err.code === "string" ? err.code : "unknown",
        message:
          typeof err.message === "string" ? err.message : "Stream failed",
      },
    };
  }
  return null;
}

/**
 * POST `/api<path>` with the bearer header and stream the SSE response into
 * the callbacks. Resolves once the stream closes (after done/error). Exactly
 * one of `onDone` / `onError` fires per call.
 */
export async function postSse(
  path: string,
  body: object,
  callbacks: SseCallbacks,
  opts: SseRequestOptions = {},
): Promise<void> {
  const token = getApiToken();
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token) headers.set("Authorization", `Bearer ${token}`);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) return; // caller cancelled — no callback
    callbacks.onError(
      "network",
      err instanceof Error ? err.message : "Network error",
    );
    return;
  }

  if (!res.ok) {
    let code = "unknown";
    let message = `Request failed (HTTP ${res.status})`;
    try {
      const errBody = (await res.json()) as {
        error?: { code?: string; message?: string };
      };
      if (errBody?.error?.code) code = errBody.error.code;
      if (errBody?.error?.message) message = errBody.error.message;
    } catch {
      /* non-JSON body — keep defaults */
    }
    callbacks.onError(code, message);
    return;
  }

  if (!res.body) {
    callbacks.onError("unknown", "Response had no body");
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let settled = false;

  const handleBlock = (block: string): boolean => {
    const event = parseSseEvent(block);
    if (!event) return false;
    if ("delta" in event) {
      callbacks.onDelta(event.delta);
      return false;
    }
    settled = true;
    if ("done" in event) callbacks.onDone(event.done);
    else callbacks.onError(event.error.code, event.error.message);
    return true;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Event blocks are separated by a blank line ("\n\n"); a partial block
      // stays in the buffer until its terminator arrives (split-chunk safe).
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        if (handleBlock(block)) {
          await reader.cancel();
          return;
        }
      }
    }
    // Flush any trailing block without a final blank line.
    buffer += decoder.decode();
    if (buffer.trim()) handleBlock(buffer);
    if (!settled) {
      callbacks.onError("stream_ended", "Stream ended without a done event");
    }
  } catch (err) {
    if (opts.signal?.aborted) return;
    if (!settled) {
      callbacks.onError(
        "network",
        err instanceof Error ? err.message : "Stream read failed",
      );
    }
  }
}
