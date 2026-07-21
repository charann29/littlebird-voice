import { describe, it, expect } from "vitest";
import {
  chunkTranscript,
  chunkText,
  contentHash,
  DEFAULT_MAX_CHARS,
  TURN_OVERLAP_CHARS,
  type SegmentLike,
} from "./chunking";

/** Build a diarized fixture: alternating speakers, `n` turns of ~`len` chars. */
function fixtureSegments(n: number, len = 120): SegmentLike[] {
  const segments: SegmentLike[] = [];
  for (let i = 0; i < n; i++) {
    const base = `turn ${i} discussing the quarterly roadmap item number ${i}. `;
    segments.push({
      speaker: String((i % 2) + 1),
      start_ms: i * 5000,
      end_ms: i * 5000 + 4500,
      text: base.repeat(Math.ceil(len / base.length)).slice(0, len),
    });
  }
  return segments;
}

const HINDI = "आज की बैठक में हमने परियोजना की समयसीमा पर चर्चा की। अगले सप्ताह तक रिपोर्ट तैयार होनी चाहिए।";
const TELUGU = "ఈ సమావేశంలో మేము ప్రాజెక్ట్ ప్రణాళికను సమీక్షించాము. వచ్చే వారం నివేదిక సిద్ధం కావాలి.";

describe("chunkTranscript", () => {
  it("is deterministic and respects size bounds", () => {
    const segments = fixtureSegments(40);
    const a = chunkTranscript(segments);
    const b = chunkTranscript(segments);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(1);
    for (const chunk of a) {
      expect(chunk.text.length).toBeLessThanOrEqual(DEFAULT_MAX_CHARS);
      expect(chunk.text.length).toBeGreaterThan(0);
    }
  });

  it("prefixes speaker labels and sets speaker metadata correctly", () => {
    const single = chunkTranscript([
      { speaker: "1", text: "hello there", start_ms: 0, end_ms: 900 },
      { speaker: "1", text: "how are you", start_ms: 1000, end_ms: 1900 },
    ]);
    expect(single).toHaveLength(1);
    expect(single[0].text).toContain("Speaker 1:");
    expect(single[0].speaker).toBe("1"); // single-speaker chunk
    expect(single[0].start_ms).toBe(0);
    expect(single[0].end_ms).toBe(1900);

    const multi = chunkTranscript([
      { speaker: "1", text: "alpha", start_ms: 0, end_ms: 500 },
      { speaker: "2", text: "beta", start_ms: 600, end_ms: 1100 },
    ]);
    expect(multi).toHaveLength(1);
    expect(multi[0].text).toContain("Speaker 1: alpha");
    expect(multi[0].text).toContain("Speaker 2: beta");
    expect(multi[0].speaker).toBeNull(); // multi-speaker chunk
  });

  it("repeats the previous chunk's last turn as overlap (capped)", () => {
    const chunks = chunkTranscript(fixtureSegments(40));
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      const firstLine = chunks[i].text.split("\n")[0];
      // Overlap line must be capped and must appear at the END of the
      // previous chunk (it is the previous chunk's last turn).
      expect(firstLine.length).toBeLessThanOrEqual(TURN_OVERLAP_CHARS);
      const tail = firstLine.replace(/^…/, "");
      expect(chunks[i - 1].text.endsWith(tail)).toBe(true);
    }
  });

  it("splits an over-long single turn on sentence boundaries", () => {
    const sentence = "This is a fairly long sentence about the project plan. ";
    const long = sentence.repeat(80); // ~4,480 chars, one turn
    const chunks = chunkTranscript([{ speaker: "1", text: long }]);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(DEFAULT_MAX_CHARS);
      expect(chunk.speaker).toBe("1");
    }
  });

  it("handles non-diarized (speaker=null) segments", () => {
    const chunks = chunkTranscript([
      { speaker: null, text: "no diarization here at all" },
    ]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("no diarization here at all");
    expect(chunks[0].speaker).toBeNull();
  });

  it("handles hi/te text (danda sentence-split, unicode intact)", () => {
    const chunks = chunkTranscript([
      { speaker: "1", text: HINDI.repeat(25) }, // long turn forces split
      { speaker: "2", text: TELUGU },
    ]);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.text).join("")).toContain("बैठक");
    expect(chunks.map((c) => c.text).join("")).toContain("సమావేశంలో");
  });

  it("returns [] for empty/whitespace input", () => {
    expect(chunkTranscript([])).toEqual([]);
    expect(chunkTranscript([{ text: "   " }])).toEqual([]);
  });
});

describe("chunkText", () => {
  it("splits on paragraph boundaries with tail overlap", () => {
    const para = "A meaningful paragraph about decisions made in the meeting. ".repeat(6).trim();
    const text = Array.from({ length: 8 }, (_, i) => `Para ${i}: ${para}`).join("\n\n");
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(DEFAULT_MAX_CHARS);
      expect(chunk.speaker).toBeNull();
    }
    // Overlap: each later chunk starts with a tail of the previous one.
    const second = chunks[1].text.split("\n\n")[0].replace(/^…/, "");
    expect(chunks[0].text.endsWith(second)).toBe(true);
  });

  it("very short text yields a single chunk; empty yields none", () => {
    expect(chunkText("short summary")).toHaveLength(1);
    expect(chunkText("")).toEqual([]);
    expect(chunkText("\n\n  \n")).toEqual([]);
  });

  it("is deterministic", () => {
    const text = "One.\n\nTwo.\n\n# Heading\nThree.";
    expect(chunkText(text)).toEqual(chunkText(text));
  });
});

describe("contentHash", () => {
  it("is a stable sha-256 hex digest", async () => {
    const a = await contentHash("hello");
    const b = await contentHash("hello");
    const c = await contentHash("hello!");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
