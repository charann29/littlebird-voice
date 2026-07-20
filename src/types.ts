export type RecordingStatus = "pending" | "transcribing" | "done" | "error";

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
