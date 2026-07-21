/**
 * Token budgeting + transcript rendering + speaker-boundary chunking.
 *
 * Token estimate: ceil(chars / 4) — no tokenizer dependency; conservative for
 * hi/te scripts, so treat the estimate as a floor and keep headroom (the
 * budget constants below already reserve 2k system/question + 2k output out
 * of the default model's 24k context).
 */

import type { SegmentRow } from "./summarize";

/** 24k model context − 2k system/question − 2k output ≈ 18k input tokens. */
export const MAX_INPUT_TOKENS = 18_000;

/** Map-step chunk size for long transcripts (speaker-turn boundaries). */
export const CHUNK_TOKENS = 10_000;

/** Head/tail excerpt size for the follow-up prompt. */
export const EXCERPT_TOKENS = 1_500;

/** ceil(chars / 4) — floor estimate, never exact. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function formatMmSs(ms: number | null | undefined): string {
  const totalSeconds = Math.max(0, Math.floor((ms ?? 0) / 1000));
  const m = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const s = String(totalSeconds % 60).padStart(2, "0");
  return `${m}:${s}`;
}

/** One transcript line: `[{speaker}] ({mm:ss}) {text}` (plan's canonical shape). */
export function renderSegmentLine(seg: SegmentRow): string {
  const speaker = seg.speaker ?? "?";
  return `[${speaker}] (${formatMmSs(seg.start_ms)}) ${seg.text}`;
}

/** Render all segments to the prompt transcript block. */
export function renderTranscript(segments: SegmentRow[]): string {
  return segments.map(renderSegmentLine).join("\n");
}

/**
 * Split segments into chunks of at most `chunkTokens` estimated tokens,
 * always on segment (speaker-turn) boundaries — never mid-utterance. A single
 * oversized segment still becomes its own chunk (never dropped).
 */
export function chunkSegments(
  segments: SegmentRow[],
  chunkTokens: number = CHUNK_TOKENS,
): SegmentRow[][] {
  const chunks: SegmentRow[][] = [];
  let current: SegmentRow[] = [];
  let currentTokens = 0;

  for (const seg of segments) {
    const segTokens = estimateTokens(renderSegmentLine(seg)) + 1; // +1 newline
    if (current.length > 0 && currentTokens + segTokens > chunkTokens) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(seg);
    currentTokens += segTokens;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** How many map-step chunks a transcript needs (1 = single-call summarize). */
export function estimateChunkCount(segments: SegmentRow[]): number {
  const total = estimateTokens(renderTranscript(segments));
  if (total <= MAX_INPUT_TOKENS) return 1;
  return chunkSegments(segments).length;
}

/**
 * First + last ~`excerptTokens` of the transcript (whole segments), used by
 * the follow-up prompt. Short transcripts are returned whole (no duplication).
 */
export function headTailExcerpt(
  segments: SegmentRow[],
  excerptTokens: number = EXCERPT_TOKENS,
): string {
  const total = estimateTokens(renderTranscript(segments));
  if (total <= excerptTokens * 2) return renderTranscript(segments);

  const head: string[] = [];
  let headTokens = 0;
  for (const seg of segments) {
    const line = renderSegmentLine(seg);
    const t = estimateTokens(line) + 1;
    if (headTokens + t > excerptTokens && head.length > 0) break;
    head.push(line);
    headTokens += t;
    if (headTokens >= excerptTokens) break;
  }

  const tail: string[] = [];
  let tailTokens = 0;
  for (let i = segments.length - 1; i >= 0; i--) {
    const line = renderSegmentLine(segments[i]);
    const t = estimateTokens(line) + 1;
    if (tailTokens + t > excerptTokens && tail.length > 0) break;
    tail.unshift(line);
    tailTokens += t;
    if (tailTokens >= excerptTokens) break;
  }

  return `${head.join("\n")}\n[…]\n${tail.join("\n")}`;
}

/**
 * Truncate a list of text blocks so the joined result stays within `budget`
 * estimated tokens; drops the lowest-position extras (end of the list first).
 */
export function capBlocksAtBudget(
  blocks: string[],
  budget: number = MAX_INPUT_TOKENS,
): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const block of blocks) {
    const t = estimateTokens(block) + 1;
    if (used + t > budget && kept.length > 0) break;
    kept.push(block);
    used += t;
    if (used >= budget) break;
  }
  return kept;
}
