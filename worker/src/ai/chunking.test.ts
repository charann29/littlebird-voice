import { describe, expect, it } from "vitest";
import {
  capBlocksAtBudget,
  chunkSegments,
  estimateChunkCount,
  estimateTokens,
  headTailExcerpt,
  renderSegmentLine,
  renderTranscript,
} from "./chunking";
import type { SegmentRow } from "./summarize";

function seg(text: string, speaker = "1", start_ms = 0): SegmentRow {
  return { speaker, start_ms, end_ms: start_ms + 1000, text };
}

describe("estimateTokens", () => {
  it("is ceil(chars/4)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("x".repeat(400))).toBe(100);
  });
});

describe("renderSegmentLine / renderTranscript", () => {
  it("renders [{speaker}] ({mm:ss}) {text}", () => {
    expect(renderSegmentLine(seg("hello", "2", 65_000))).toBe("[2] (01:05) hello");
  });

  it("uses ? for null speaker and 00:00 for null start", () => {
    expect(
      renderSegmentLine({ speaker: null, start_ms: null, end_ms: null, text: "hi" }),
    ).toBe("[?] (00:00) hi");
  });

  it("joins lines with newlines", () => {
    const t = renderTranscript([seg("a"), seg("b")]);
    expect(t.split("\n")).toHaveLength(2);
  });
});

describe("chunkSegments", () => {
  it("keeps everything in one chunk when under budget", () => {
    const segments = [seg("short one"), seg("short two")];
    expect(chunkSegments(segments, 1000)).toHaveLength(1);
  });

  it("splits on segment boundaries, never mid-utterance", () => {
    // each line ≈ (12 + 100)/4 ≈ 29 tokens; chunk budget 60 → 2 per chunk
    const segments = Array.from({ length: 6 }, (_, i) =>
      seg("y".repeat(100), String(i)),
    );
    const chunks = chunkSegments(segments, 60);
    expect(chunks.length).toBeGreaterThan(1);
    // no segment lost or split
    const flat = chunks.flat();
    expect(flat).toHaveLength(6);
    expect(flat.map((s) => s.speaker)).toEqual(["0", "1", "2", "3", "4", "5"]);
  });

  it("puts an oversized single segment in its own chunk instead of dropping it", () => {
    const big = seg("z".repeat(10_000));
    const chunks = chunkSegments([seg("small"), big, seg("small2")], 50);
    expect(chunks.flat()).toHaveLength(3);
    expect(chunks.some((c) => c.length === 1 && c[0] === big)).toBe(true);
  });
});

describe("estimateChunkCount", () => {
  it("returns 1 for short transcripts", () => {
    expect(estimateChunkCount([seg("hello world")])).toBe(1);
  });

  it("returns the map chunk count for long transcripts", () => {
    // > 18k tokens total → chunked at ~10k → at least 2
    const segments = Array.from({ length: 40 }, () => seg("w".repeat(8_000)));
    expect(estimateChunkCount(segments)).toBeGreaterThan(1);
  });
});

describe("headTailExcerpt", () => {
  it("returns the whole transcript when short", () => {
    const segments = [seg("a"), seg("b")];
    expect(headTailExcerpt(segments)).toBe(renderTranscript(segments));
  });

  it("returns head + […] + tail for long transcripts", () => {
    const segments = Array.from({ length: 50 }, (_, i) =>
      seg(`utterance ${i} ${"x".repeat(400)}`),
    );
    const excerpt = headTailExcerpt(segments, 300);
    expect(excerpt).toContain("[…]");
    expect(excerpt).toContain("utterance 0");
    expect(excerpt).toContain("utterance 49");
    expect(excerpt).not.toContain("utterance 25");
    expect(estimateTokens(excerpt)).toBeLessThan(1000);
  });
});

describe("capBlocksAtBudget", () => {
  it("keeps blocks from the start and drops overflow", () => {
    const blocks = ["a".repeat(400), "b".repeat(400), "c".repeat(400)];
    const kept = capBlocksAtBudget(blocks, 220); // ~100 tokens per block
    expect(kept).toEqual([blocks[0], blocks[1]]);
  });

  it("always keeps at least one block", () => {
    expect(capBlocksAtBudget(["x".repeat(4000)], 10)).toHaveLength(1);
  });
});
