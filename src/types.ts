export type RecordingStatus = "pending" | "transcribing" | "done" | "error";

/**
 * Derived/display sync state ("local" = never synced, "dirty" = changes
 * queued, "synced" = server acknowledged). The syncOutbox store is the
 * retry source of truth; this is only for UI badges.
 */
export type SyncState = "local" | "dirty" | "synced";

/** One diarized transcript segment persisted from the async transcript. */
export interface TranscriptSegment {
  speaker: string | null;
  start_ms: number | null;
  end_ms: number | null;
  text: string;
}

/** A pending sync operation persisted in the syncOutbox IndexedDB store. */
export interface SyncOp {
  /** crypto.randomUUID() */
  opId: string;
  recordingId: string;
  op: "upsert" | "delete";
  /** Date.now() when the op was enqueued */
  enqueuedAt: number;
  /** Failed drain attempts so far (backoff input). */
  attempts: number;
  lastError: string | null;
  /** Date.now() of the last failed attempt (backoff clock; unset = never). */
  lastAttemptAt?: number;
}

export interface Recording {
  /** crypto.randomUUID() */
  id: string;
  /** Date.now() at creation */
  createdAt: number;
  /** recording length in ms */
  durationMs: number;
  /** e.g. "audio/webm;codecs=opus" */
  mimeType: string;
  /** size of the audio blob in bytes */
  blobSize: number;
  /** the captured audio, stored directly in IndexedDB */
  blob: Blob;
  status: RecordingStatus;
  transcript: string | null;
  error: string | null;
  /** Soniox file id, persisted immediately after upload for crash recovery */
  sonioxFileId: string | null;
  /** Soniox transcription id, persisted immediately after job creation */
  sonioxTranscriptionId: string | null;
  /** Diarized segments from the async transcript (null when unavailable). */
  segments: TranscriptSegment[] | null;
  /** Derived sync display state (outbox is the retry source of truth). */
  syncState: SyncState;
}

/** Progress stages surfaced while an async transcription runs. */
export type TranscribeStage =
  | "uploading"
  | "creating"
  | "polling"
  | "fetching";

export interface SonioxTranscript {
  id?: string;
  text?: string;
  tokens?: Array<{
    text: string;
    start_ms?: number;
    end_ms?: number;
    confidence?: number;
    speaker?: string;
  }>;
}
