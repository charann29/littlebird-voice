/**
 * Frontend mirror of the section-20 AI payload types (worker/src/ai/types.ts
 * and worker/src/ai/ask.ts). The worker and PWA have separate tsconfig roots,
 * so the shapes are duplicated here — keep in sync with the worker.
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

/** Stored meeting-summary payload (summaries.payload_json, kind "meeting_summary"). */
export interface SummaryV1 {
  version: 1;
  /** Model id used to generate this summary. */
  model: string;
  /** sessions.transcript_revision this was built from (idempotency). */
  source_revision: number;
  /** requestId of a forced regeneration, else null (idempotency). */
  request_id: string | null;
  /** 2-4 sentences. */
  overview: string;
  action_items: SummaryActionItem[];
  decisions: string[];
  key_quotes: SummaryKeyQuote[];
  risks_open_questions: string[];
}

/** GET /api/sessions/:id/summary response. */
export interface StoredSummaryResponse {
  summary: SummaryV1;
  /** Epoch ms. */
  generated_at: number;
}

/** POST /api/sessions/:id/summarize — 200 response. */
export interface SummarizeResponse {
  summary: SummaryV1;
}

/** POST /api/sessions/:id/summarize — 202 response for long transcripts. */
export interface SummarizeQueuedResponse {
  status: "queued";
}

/** Source citation from the final SSE event of POST /api/ask (scope=all). */
export interface AskSource {
  session_id: string;
  title: string;
  snippet: string;
}

export type FollowupFormat = "email" | "message";

export type AskScope = "session" | "all";
