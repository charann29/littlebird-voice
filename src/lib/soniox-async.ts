/**
 * Soniox async ("transcribe-when-online") REST client + orchestrator.
 *
 * This is the network seam for offline-first transcription. Recorded audio is
 * captured and persisted locally regardless of connectivity; these functions
 * are invoked opportunistically when the app believes it is online.
 *
 * IMPORTANT: navigator.onLine is a hint, not a guarantee — it can report
 * "online" on a captive/dead network and "offline" in some environments even
 * when reachable. So callers should NOT hard-gate on navigator.onLine. Instead
 * attempt the network operation with these functions and surface any thrown
 * error to the UI (which can then show a retry affordance).
 *
 * Auth: every request goes through the Worker's allow-listed /api/stt/*
 * relay with the app bearer token; the Worker injects the Soniox key.
 */

import {
  API_BASE,
  ASYNC_MODEL,
  LANGUAGE_HINTS,
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
} from "../config";
import { getApiToken } from "./api";
import type {
  SonioxTranscript,
  TranscribeStage,
  TranscriptSegment,
} from "../types";

/**
 * Auth headers shared by every relay call: the APP bearer token (same-origin
 * Worker), never a Soniox key — the Worker injects that server-side.
 */
export function authHeaders(): HeadersInit {
  const token = getApiToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Thrown when a transcription job reaches a TERMINAL failure state (the remote
 * job itself errored / was rejected). Distinguished from transient errors
 * (network hiccups, timeouts, aborts) so callers can decide whether to RESUME
 * an existing job (transient) or discard it and start fresh (terminal).
 */
export class TranscriptionTerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptionTerminalError";
  }
}

/**
 * Perform a Soniox REST call with auth headers attached, throwing a rich error
 * (see errorFromResponse) on any non-2xx response. This is the single place
 * that knows API_BASE + auth, so per-call sites only specify path/method/body.
 */
async function sonioxFetch(
  path: string,
  label: string,
  init: RequestInit = {},
): Promise<Response> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...init.headers },
  });
  if (!res.ok) throw await errorFromResponse(res, label);
  return res;
}

/** Fire-and-forget DELETE that never throws — used for best-effort cleanup. */
async function bestEffortDelete(path: string): Promise<void> {
  try {
    await fetch(`${API_BASE}${path}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
  } catch {
    /* non-fatal */
  }
}

/** Build a human-readable error message from a failed Response. */
async function errorFromResponse(res: Response, label: string): Promise<Error> {
  let detail = "";
  try {
    const body = await res.clone().json();
    detail =
      (body?.error_message as string) ||
      (body?.message as string) ||
      (body?.error as string) ||
      "";
    if (body?.error_type && detail) {
      detail = `${body.error_type}: ${detail}`;
    } else if (body?.error_type) {
      detail = body.error_type as string;
    }
  } catch {
    try {
      detail = (await res.clone().text()).slice(0, 300);
    } catch {
      detail = "";
    }
  }
  const suffix = detail ? ` — ${detail}` : "";
  return new Error(`${label} failed (HTTP ${res.status})${suffix}`);
}

/** Choose a sensible upload filename/extension from the blob mime type. */
function filenameForMime(mimeType: string): string {
  const type = mimeType.toLowerCase();
  if (type.includes("webm")) return "recording.webm";
  if (type.includes("mp4") || type.includes("m4a") || type.includes("aac"))
    return "recording.mp4";
  if (type.includes("ogg")) return "recording.ogg";
  if (type.includes("wav")) return "recording.wav";
  if (type.includes("mpeg") || type.includes("mp3")) return "recording.mp3";
  return "recording.webm";
}

/**
 * Step 1 — Upload the audio blob. Returns the Soniox file id (response field
 * `id`, NOT `file_id`).
 */
export async function uploadFile(
  blob: Blob,
  signal?: AbortSignal,
): Promise<string> {
  const form = new FormData();
  const filename = filenameForMime(blob.type || "audio/webm");
  form.append("file", blob, filename);

  const res = await sonioxFetch("/files", "Upload", {
    method: "POST",
    body: form,
    signal,
  });
  const data = await res.json();
  const fileId = data?.id as string | undefined;
  if (!fileId) throw new Error("Upload succeeded but no file id was returned");
  return fileId;
}

/**
 * Step 2 — Create an async transcription job for an uploaded file. Returns the
 * transcription id (response field `id`).
 */
export async function createTranscription(
  fileId: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await sonioxFetch("/transcriptions", "Create transcription", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ASYNC_MODEL,
      file_id: fileId,
      language_hints: LANGUAGE_HINTS,
    }),
    signal,
  });
  const data = await res.json();
  const id = data?.id as string | undefined;
  if (!id)
    throw new Error("Create transcription succeeded but no id was returned");
  return id;
}

/**
 * Step 3 — Poll a transcription until it reaches a terminal state. Resolves
 * when status === "completed"; throws TranscriptionTerminalError on a terminal
 * failure status, or a plain Error when POLL_TIMEOUT_MS elapses.
 *
 * A deadline AbortSignal (AbortSignal.timeout) is composed with the caller's
 * signal so that a STALLED individual fetch/sleep is aborted rather than
 * hanging forever — fetch has no intrinsic timeout of its own.
 */
export async function pollTranscription(
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  const deadlineSignal = AbortSignal.timeout(POLL_TIMEOUT_MS);
  const composite = signal
    ? AbortSignal.any([signal, deadlineSignal])
    : deadlineSignal;

  // Translate a deadline-only abort into a readable timeout error.
  const asError = (err: unknown): Error => {
    if (deadlineSignal.aborted && !(signal?.aborted ?? false)) {
      return new Error(
        `Transcription timed out after ${Math.round(POLL_TIMEOUT_MS / 1000)}s`,
      );
    }
    return err instanceof Error ? err : new Error(String(err));
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (deadlineSignal.aborted) {
      throw new Error(
        `Transcription timed out after ${Math.round(POLL_TIMEOUT_MS / 1000)}s`,
      );
    }
    let data: Record<string, unknown>;
    try {
      const res = await sonioxFetch(
        `/transcriptions/${id}`,
        "Poll transcription",
        { method: "GET", signal: composite },
      );
      data = await res.json();
    } catch (err) {
      throw asError(err);
    }
    const status = data?.status as string | undefined;
    if (status === "completed") return;
    if (status && status !== "queued" && status !== "processing") {
      const detail =
        (data?.error_message as string) ||
        (data?.error_type as string) ||
        `terminal status "${status}"`;
      throw new TranscriptionTerminalError(`Transcription failed — ${detail}`);
    }
    try {
      await sleep(POLL_INTERVAL_MS, composite);
    } catch (err) {
      throw asError(err);
    }
  }
}

/** Text + diarized segments for a completed transcription. */
export interface TranscriptFetchResult {
  text: string;
  /** Diarized segments derived from Soniox tokens (null when unavailable). */
  segments: TranscriptSegment[] | null;
}

/**
 * Group Soniox tokens into diarized segments: consecutive tokens with the
 * same speaker label merge into one segment carrying start/end timings.
 */
export function tokensToSegments(
  tokens: NonNullable<SonioxTranscript["tokens"]>,
): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  for (const token of tokens) {
    const speaker = token.speaker ?? null;
    const last = segments[segments.length - 1];
    if (last && last.speaker === speaker) {
      last.text += token.text;
      if (typeof token.end_ms === "number") last.end_ms = token.end_ms;
      if (last.start_ms === null && typeof token.start_ms === "number") {
        last.start_ms = token.start_ms;
      }
    } else {
      segments.push({
        speaker,
        start_ms: typeof token.start_ms === "number" ? token.start_ms : null,
        end_ms: typeof token.end_ms === "number" ? token.end_ms : null,
        text: token.text,
      });
    }
  }
  // Trim leading whitespace Soniox puts on token boundaries.
  for (const seg of segments) seg.text = seg.text.trim();
  return segments.filter((seg) => seg.text.length > 0);
}

/**
 * Step 4 — Fetch the transcript (text + diarized segments) for a completed
 * transcription.
 */
export async function getTranscript(
  id: string,
  signal?: AbortSignal,
): Promise<TranscriptFetchResult> {
  const res = await sonioxFetch(
    `/transcriptions/${id}/transcript`,
    "Get transcript",
    { method: "GET", signal },
  );
  const data = (await res.json()) as SonioxTranscript;
  const segments = Array.isArray(data.tokens)
    ? tokensToSegments(data.tokens)
    : null;
  let text = "";
  if (typeof data.text === "string" && data.text.length > 0) {
    text = data.text;
  } else if (Array.isArray(data.tokens)) {
    text = data.tokens.map((t) => t.text).join("");
  }
  return { text, segments };
}

/**
 * Best-effort cleanup of remote resources after a SUCCESSFUL transcription.
 * Failures are non-fatal and swallowed — the local copy is the source of truth.
 */
export async function deleteRemote(
  fileId?: string | null,
  transcriptionId?: string | null,
): Promise<void> {
  if (transcriptionId) {
    await bestEffortDelete(`/transcriptions/${transcriptionId}`);
  }
  if (fileId) {
    await bestEffortDelete(`/files/${fileId}`);
  }
}

export interface TranscribeCallbacks {
  /** Called as the flow progresses through stages. */
  onStage?: (stage: TranscribeStage) => void;
  /**
   * Called with the file id IMMEDIATELY after upload, then again with the
   * transcription id IMMEDIATELY after job creation, so the caller can persist
   * them for crash recovery. May return a Promise; the orchestrator AWAITS it
   * before advancing, so the caller can guarantee the id is committed (and can
   * throw/abort to cancel the flow, e.g. if the record was deleted).
   */
  onIds?: (ids: {
    fileId?: string;
    transcriptionId?: string;
  }) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface TranscribeResult {
  transcript: string;
  /** Diarized segments from Soniox tokens (null when unavailable). */
  segments: TranscriptSegment[] | null;
  fileId: string;
  transcriptionId: string;
}

/**
 * Full orchestrator: upload → create → poll → fetch. Emits stage + id events
 * along the way so callers can persist progress and recover from crashes. The
 * onIds events are AWAITED so persistence is committed before proceeding.
 */
export async function transcribeBlob(
  blob: Blob,
  { onStage, onIds, signal }: TranscribeCallbacks = {},
): Promise<TranscribeResult> {
  onStage?.("uploading");
  const fileId = await uploadFile(blob, signal);
  await onIds?.({ fileId });

  onStage?.("creating");
  const transcriptionId = await createTranscription(fileId, signal);
  await onIds?.({ transcriptionId });

  onStage?.("polling");
  await pollTranscription(transcriptionId, signal);

  onStage?.("fetching");
  const { text, segments } = await getTranscript(transcriptionId, signal);

  return { transcript: text, segments, fileId, transcriptionId };
}

/**
 * Resume polling an EXISTING transcription id (from a previous session that was
 * interrupted mid-flight), then fetch its transcript. Used to recover items
 * that were left stranded in the "transcribing" state.
 */
export async function resumePoll(
  transcriptionId: string,
  signal?: AbortSignal,
): Promise<TranscriptFetchResult> {
  await pollTranscription(transcriptionId, signal);
  return getTranscript(transcriptionId, signal);
}

/** Promise-based sleep that rejects if the signal aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
