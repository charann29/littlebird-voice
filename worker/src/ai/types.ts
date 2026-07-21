/**
 * SummaryV1 — the canonical structured-summary payload stored in
 * `summaries.payload_json` (kind "meeting_summary") via `saveSummary`.
 *
 * `SummaryContent` is what the MODEL produces (matches SUMMARY_SCHEMA in
 * prompts.ts); `SummaryV1` wraps it with the server-side envelope fields
 * (version/model/source_revision/request_id) added by generateSummary.
 *
 * The frontend mirror of these types lives in `src/lib/ai-types.ts` (the
 * worker and the PWA have separate tsconfig roots, mirroring how section 10
 * duplicated SegmentInput).
 */

export interface SummaryActionItem {
  text: string;
  /** Owner name/label when stated or clearly inferable, else null. */
  owner: string | null;
  /** Due date/phrase when stated or clearly inferable, else null. */
  due: string | null;
}

export interface SummaryKeyQuote {
  speaker: string | null;
  /** Verbatim quote, kept in its original language. */
  quote: string;
}

/** Model-produced sections (the JSON-mode output shape). */
export interface SummaryContent {
  /** 2-4 sentences. */
  overview: string;
  action_items: SummaryActionItem[];
  decisions: string[];
  key_quotes: SummaryKeyQuote[];
  risks_open_questions: string[];
}

/** Full stored payload (summaries.payload_json). */
export interface SummaryV1 extends SummaryContent {
  version: 1;
  /** Model id used to generate this summary. */
  model: string;
  /** sessions.transcript_revision this was built from (idempotency). */
  source_revision: number;
  /** requestId of a forced regeneration, else null (idempotency). */
  request_id: string | null;
}

function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

/**
 * Validate a parsed model output against the SummaryContent shape.
 * Returns a normalized copy, or null when the shape is invalid.
 */
export function validateSummaryContent(value: unknown): SummaryContent | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const v = value as Record<string, unknown>;
  if (typeof v.overview !== "string") return null;
  if (
    !Array.isArray(v.action_items) ||
    !Array.isArray(v.decisions) ||
    !Array.isArray(v.key_quotes) ||
    !Array.isArray(v.risks_open_questions)
  ) {
    return null;
  }

  const action_items: SummaryActionItem[] = [];
  for (const raw of v.action_items) {
    if (raw === null || typeof raw !== "object") return null;
    const item = raw as Record<string, unknown>;
    if (typeof item.text !== "string") return null;
    action_items.push({
      text: item.text,
      owner: isStringOrNull(item.owner ?? null) ? ((item.owner ?? null) as string | null) : null,
      due: isStringOrNull(item.due ?? null) ? ((item.due ?? null) as string | null) : null,
    });
  }

  const decisions: string[] = [];
  for (const d of v.decisions) {
    if (typeof d !== "string") return null;
    decisions.push(d);
  }

  const key_quotes: SummaryKeyQuote[] = [];
  for (const raw of v.key_quotes) {
    if (raw === null || typeof raw !== "object") return null;
    const q = raw as Record<string, unknown>;
    if (typeof q.quote !== "string") return null;
    key_quotes.push({
      speaker: isStringOrNull(q.speaker ?? null) ? ((q.speaker ?? null) as string | null) : null,
      quote: q.quote,
    });
  }

  const risks_open_questions: string[] = [];
  for (const r of v.risks_open_questions) {
    if (typeof r !== "string") return null;
    risks_open_questions.push(r);
  }

  return { overview: v.overview, action_items, decisions, key_quotes, risks_open_questions };
}

/** Validate a full stored SummaryV1 payload (used when re-reading rows). */
export function isSummaryV1(value: unknown): value is SummaryV1 {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    typeof v.model === "string" &&
    typeof v.source_revision === "number" &&
    (v.request_id === null || typeof v.request_id === "string") &&
    validateSummaryContent(value) !== null
  );
}
