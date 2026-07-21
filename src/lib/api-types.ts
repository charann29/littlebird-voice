/**
 * Shared request/response types for the Worker API (`/api/*`) — mirrors the
 * endpoint table in the v2 plan. Sections 20/30/40 import from here.
 */

/** Canonical session status enum ('done' = transcript complete). */
export type SessionStatus = "pending" | "transcribing" | "done" | "error";

export type SessionSource = "mic" | "tab" | "screen";

/** Session row as returned by the API (no segments). */
export interface SessionMeta {
  id: string;
  user_id: string;
  title: string;
  source: SessionSource;
  status: SessionStatus;
  created_at: number;
  updated_at: number;
  duration_ms: number;
  mime_type: string | null;
  blob_size: number | null;
  /** Diarization label of the app user ("1","2",…) or null; set via PATCH. */
  self_speaker: string | null;
  /** Server-side monotonic counter bumped by each transcript write. */
  transcript_revision: number;
  error: string | null;
  /**
   * True when at least one summary row exists (GET /api/sessions list only;
   * computed via a correlated EXISTS server-side). Absent on other responses.
   */
  has_summary?: boolean;
}

/** One diarized transcript segment. */
export interface Segment {
  id: number;
  session_id: string;
  seq: number;
  speaker: string | null;
  start_ms: number | null;
  end_ms: number | null;
  text: string;
}

/** Summary metadata (payload omitted in session-detail listings). */
export interface SummaryMeta {
  id: string;
  kind: string;
  model: string | null;
  /** Server-side monotonic counter bumped on each upsert. */
  revision: number;
  created_at: number;
}

/** Full summary incl. payload (GET /sessions/:id/summaries, PUT response). */
export interface Summary extends SummaryMeta {
  payload: object;
}

// ---- Request bodies -------------------------------------------------------

/** PUT /api/sessions/:id — idempotent upsert keyed on the client UUID. */
export interface PutSessionBody {
  title?: string;
  source: SessionSource;
  status: SessionStatus;
  created_at: number;
  updated_at: number;
  duration_ms: number;
  mime_type?: string | null;
  blob_size?: number | null;
  self_speaker?: string | null;
  error?: string | null;
}

/** PATCH /api/sessions/:id — any subset of PUT fields. */
export type PatchSessionBody = Partial<PutSessionBody>;

/** PUT /api/sessions/:id/transcript */
export interface PutTranscriptBody {
  segments: SegmentInput[];
}

export interface SegmentInput {
  speaker?: string | null;
  start_ms?: number | null;
  end_ms?: number | null;
  text: string;
}

/** PUT /api/sessions/:id/summaries/:kind */
export interface PutSummaryBody {
  payload: object;
  model?: string;
}

// ---- Responses ------------------------------------------------------------

export interface SessionsListResponse {
  sessions: SessionMeta[];
}

export interface SessionResponse {
  session: SessionMeta;
}

export interface SessionDetailResponse {
  session: SessionMeta;
  segments: Segment[];
  summaries: SummaryMeta[];
}

export interface TranscriptResponse {
  segments: Segment[];
  /** All segment texts joined. */
  text: string;
}

export interface PutTranscriptResponse {
  count: number;
}

export interface SummariesResponse {
  summaries: Summary[];
}

export interface SummaryResponse {
  summary: Summary;
}

/** POST /api/auth/soniox-token */
export interface SonioxTokenResponse {
  api_key: string;
  expires_at?: string;
}
