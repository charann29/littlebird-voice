/**
 * Pure chunking functions for memory ingestion (section 30).
 *
 * - `chunkTranscript`: diarized transcripts. Unit = speaker turn (consecutive
 *   same-speaker segments). Turns are packed into ~1,000-char chunks (hard max
 *   1,800); a turn longer than the max is split on sentence boundaries. The
 *   last turn of a chunk (capped at 200 chars) is repeated at the start of the
 *   next chunk (turn-level overlap). Chunk text carries speaker prefixes
 *   ("Speaker 1: …") so embeddings capture who said what.
 * - `chunkText`: non-diarized text (summaries, documents). Paragraph/heading
 *   split, same size targets, 150-char tail overlap.
 *
 * Both are deterministic — identical input always yields identical chunks
 * (idempotent re-ingest relies on this via content hashing).
 */

export interface ChunkingOptions {
  /** Soft packing target in chars (default 1000). */
  targetChars?: number;
  /** Hard max chunk size in chars (default 1800). */
  maxChars?: number;
}

export const DEFAULT_TARGET_CHARS = 1000;
export const DEFAULT_MAX_CHARS = 1800;
/** Max chars of the previous speaker turn repeated as overlap. */
export const TURN_OVERLAP_CHARS = 200;
/** Tail overlap for non-diarized text. */
export const TEXT_OVERLAP_CHARS = 150;

/** Input segment shape (matches transcript_segments rows / Soniox tokens). */
export interface SegmentLike {
  speaker?: string | null;
  start_ms?: number | null;
  end_ms?: number | null;
  text: string;
}

/** One produced chunk (text + provenance metadata). */
export interface Chunk {
  text: string;
  /** Speaker label when the chunk is single-speaker, else null. */
  speaker: string | null;
  start_ms: number | null;
  end_ms: number | null;
}

interface Turn {
  speaker: string | null;
  start_ms: number | null;
  end_ms: number | null;
  text: string;
}

/** Group consecutive same-speaker segments into turns. */
function groupTurns(segments: SegmentLike[]): Turn[] {
  const turns: Turn[] = [];
  for (const seg of segments) {
    const text = seg.text.trim();
    if (!text) continue;
    const speaker = seg.speaker ?? null;
    const last = turns[turns.length - 1];
    if (last && last.speaker === speaker) {
      last.text += ` ${text}`;
      if (seg.end_ms != null) last.end_ms = seg.end_ms;
    } else {
      turns.push({
        speaker,
        start_ms: seg.start_ms ?? null,
        end_ms: seg.end_ms ?? null,
        text,
      });
    }
  }
  return turns;
}

/** Split text into sentence-ish pieces no longer than `limit` chars. */
function splitSentences(text: string, limit: number): string[] {
  // Sentence enders incl. Devanagari danda (।) for hi; te uses ./?/!.
  const sentences = text.match(/[^.!?।]+[.!?।]*\s*/g) ?? [text];
  const pieces: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > limit) {
      pieces.push(current.trim());
      current = "";
    }
    // A single sentence longer than the limit is hard-wrapped on whitespace.
    if (sentence.length > limit) {
      if (current) {
        pieces.push(current.trim());
        current = "";
      }
      let rest = sentence.trim();
      while (rest.length > limit) {
        let cut = rest.lastIndexOf(" ", limit);
        if (cut <= 0) cut = limit;
        pieces.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      current = rest;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) pieces.push(current.trim());
  return pieces.filter((p) => p.length > 0);
}

function renderTurn(turn: Turn): string {
  return turn.speaker != null ? `Speaker ${turn.speaker}: ${turn.text}` : turn.text;
}

/** Overlap snippet from a turn: rendered text capped at TURN_OVERLAP_CHARS. */
function turnOverlap(turn: Turn): string {
  const rendered = renderTurn(turn);
  if (rendered.length <= TURN_OVERLAP_CHARS) return rendered;
  return `…${rendered.slice(rendered.length - (TURN_OVERLAP_CHARS - 1))}`;
}

/**
 * Chunk a diarized transcript (speaker-turn packing + last-turn overlap).
 * Deterministic; returns [] for empty input.
 */
export function chunkTranscript(
  segments: SegmentLike[],
  opts: ChunkingOptions = {},
): Chunk[] {
  const target = opts.targetChars ?? DEFAULT_TARGET_CHARS;
  const max = opts.maxChars ?? DEFAULT_MAX_CHARS;

  // Units = turns, with over-long turns split into sentence pieces that keep
  // the turn's speaker + timestamps.
  const units: Turn[] = [];
  for (const turn of groupTurns(segments)) {
    if (renderTurn(turn).length <= max) {
      units.push(turn);
    } else {
      for (const piece of splitSentences(turn.text, target)) {
        units.push({ ...turn, text: piece });
      }
    }
  }
  if (units.length === 0) return [];

  const chunks: Chunk[] = [];
  let parts: string[] = [];
  let members: Turn[] = []; // real (non-overlap) units in the current chunk
  let length = 0;

  const flush = () => {
    if (members.length === 0) return;
    const speakers = new Set(members.map((u) => u.speaker));
    chunks.push({
      text: parts.join("\n"),
      speaker: speakers.size === 1 ? (members[0].speaker ?? null) : null,
      start_ms: members[0].start_ms,
      end_ms: members[members.length - 1].end_ms,
    });
  };

  for (const unit of units) {
    const rendered = renderTurn(unit);
    if (members.length > 0 && length + 1 + rendered.length > target) {
      const prevLast = members[members.length - 1];
      flush();
      // Start the next chunk with the previous chunk's last turn as overlap.
      const overlap = turnOverlap(prevLast);
      if (overlap.length + 1 + rendered.length <= max) {
        parts = [overlap];
        length = overlap.length;
      } else {
        parts = [];
        length = 0;
      }
      members = [];
    }
    parts.push(rendered);
    members.push(unit);
    length += (length > 0 ? 1 : 0) + rendered.length;
  }
  flush();
  return chunks;
}

/**
 * Chunk non-diarized text (summaries, documents): paragraph/heading split,
 * ~1,000-char packing (hard max 1,800), 150-char tail overlap.
 */
export function chunkText(text: string, opts: ChunkingOptions = {}): Chunk[] {
  const target = opts.targetChars ?? DEFAULT_TARGET_CHARS;
  const max = opts.maxChars ?? DEFAULT_MAX_CHARS;

  // Paragraph boundaries: blank lines; headings (#/##/…) start a new unit too.
  const paragraphs = text
    .split(/\n\s*\n|\n(?=#{1,6}\s)/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const units: string[] = [];
  for (const para of paragraphs) {
    if (para.length <= max) units.push(para);
    else units.push(...splitSentences(para, target));
  }
  if (units.length === 0) return [];

  const chunks: string[] = [];
  let parts: string[] = [];
  let hasReal = false; // current chunk contains at least one real unit
  let length = 0;

  for (const unit of units) {
    if (hasReal && length + 2 + unit.length > target) {
      const chunkText = parts.join("\n\n");
      chunks.push(chunkText);
      // Tail overlap (word-boundary cut, capped at TEXT_OVERLAP_CHARS).
      let overlap = chunkText.slice(-TEXT_OVERLAP_CHARS);
      const firstSpace = overlap.indexOf(" ");
      if (chunkText.length > TEXT_OVERLAP_CHARS && firstSpace > 0) {
        overlap = `…${overlap.slice(firstSpace + 1)}`;
      }
      if (overlap.length + 2 + unit.length <= max) {
        parts = [overlap];
        length = overlap.length;
      } else {
        parts = [];
        length = 0;
      }
      hasReal = false;
    }
    parts.push(unit);
    hasReal = true;
    length += (length > 0 ? 2 : 0) + unit.length;
  }
  if (hasReal) chunks.push(parts.join("\n\n"));

  return chunks.map((t) => ({
    text: t,
    speaker: null,
    start_ms: null,
    end_ms: null,
  }));
}

/** sha-256 hex of a chunk's text (content-hash idempotency key). */
export async function contentHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
