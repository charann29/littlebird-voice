/**
 * Segment-mapping tests for soniox-async: tokensToSegments grouping rules and
 * getTranscript's {text, segments} shape (mocked fetch through the relay).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { setApiToken } from "./api";
import { getTranscript, tokensToSegments } from "./soniox-async";

afterEach(() => {
  setApiToken(null);
  vi.unstubAllGlobals();
});

describe("tokensToSegments", () => {
  it("groups consecutive same-speaker tokens into one segment with merged timings", () => {
    const segments = tokensToSegments([
      { text: "Hello", start_ms: 0, end_ms: 300, speaker: "1" },
      { text: " world", start_ms: 300, end_ms: 600, speaker: "1" },
      { text: " Hi", start_ms: 700, end_ms: 900, speaker: "2" },
    ]);
    expect(segments).toEqual([
      { speaker: "1", start_ms: 0, end_ms: 600, text: "Hello world" },
      { speaker: "2", start_ms: 700, end_ms: 900, text: "Hi" },
    ]);
  });

  it("re-splits when the same speaker returns after another", () => {
    const segments = tokensToSegments([
      { text: "a", speaker: "1" },
      { text: "b", speaker: "2" },
      { text: "c", speaker: "1" },
    ]);
    expect(segments.map((s) => s.speaker)).toEqual(["1", "2", "1"]);
  });

  it("handles missing speakers/timings (nulls) and drops empty segments", () => {
    const segments = tokensToSegments([
      { text: "  " }, // whitespace-only ⇒ dropped
      { text: "solo" },
    ]);
    expect(segments).toEqual([
      { speaker: null, start_ms: null, end_ms: null, text: "solo" },
    ]);
  });
});

describe("getTranscript", () => {
  it("returns {text, segments} from a token payload via the /api/stt relay", async () => {
    setApiToken("t");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        expect(String(input)).toBe("/api/stt/transcriptions/tx1/transcript");
        return new Response(
          JSON.stringify({
            text: "Hello world",
            tokens: [
              { text: "Hello", start_ms: 0, end_ms: 300, speaker: "1" },
              { text: " world", start_ms: 300, end_ms: 600, speaker: "1" },
            ],
          }),
          { status: 200 },
        );
      }),
    );

    const result = await getTranscript("tx1");
    expect(result.text).toBe("Hello world");
    expect(result.segments).toEqual([
      { speaker: "1", start_ms: 0, end_ms: 600, text: "Hello world" },
    ]);
  });

  it("returns segments: null when the payload has no tokens array", async () => {
    setApiToken("t");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ text: "plain" }), { status: 200 }),
      ),
    );

    const result = await getTranscript("tx2");
    expect(result).toEqual({ text: "plain", segments: null });
  });
});
