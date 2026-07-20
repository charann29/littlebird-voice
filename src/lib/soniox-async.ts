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
 * Auth: every request sends `Authorization: Bearer <SONIOX_API_KEY>`.
 */

import {
  API_BASE,
  ASYNC_MODEL,
  LANGUAGE_HINTS,
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  SONIOX_API_KEY,
} from "../config";
import type { SonioxTranscript, TranscribeStage } from "../types";

/** Auth headers shared by every Soniox REST call. */
export function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${SONIOX_API_KEY}` };
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

  const res = await fetch(`${API_BASE}/v1/files`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
    signal,
  });
  if (!res.ok) throw await errorFromResponse(res, "Upload");
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
  const res = await fetch(`${API_BASE}/v1/transcriptions`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ASYNC_MODEL,
      file_id: fileId,
      language_hints: LANGUAGE_HINTS,
    }),
    signal,
  });
  if (!res.ok) throw await errorFromResponse(res, "Create transcription");
  const data = await res.json();
  const id = data?.id as string | undefined;
  if (!id)
    throw new Error("Create transcription succeeded but no id was returned");
  return id;
}

/**
 * Step 3 — Poll a transcription until it reaches a terminal state. Resolves
 * when status === "completed"; throws on any other terminal status ("error")
 * or when POLL_TIMEOUT_MS elapses.
 */
export async function pollTranscription(
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const res = await fetch(`${API_BASE}/v1/transcriptions/${id}`, {
      method: "GET",
      headers: authHeaders(),
      signal,
    });
    if (!res.ok) throw await errorFromResponse(res, "Poll transcription");
    const data = await res.json();
    const status = data?.status as string | undefined;
    if (status === "completed") return;
    if (status === "error" || (status && status !== "queued" && status !== "processing")) {
      const detail =
        (data?.error_message as string) ||
        (data?.error_type as string) ||
        `terminal status "${status}"`;
      throw new Error(`Transcription failed — ${detail}`);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Transcription timed out after ${Math.round(POLL_TIMEOUT_MS / 1000)}s (still ${status ?? "unknown"})`,
      );
    }
    await sleep(POLL_INTERVAL_MS, signal);
  }
}

/** Step 4 — Fetch the transcript text for a completed transcription. */
export async function getTranscript(
  id: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(`${API_BASE}/v1/transcriptions/${id}/transcript`, {
    method: "GET",
    headers: authHeaders(),
    signal,
  });
  if (!res.ok) throw await errorFromResponse(res, "Get transcript");
  const data = (await res.json()) as SonioxTranscript;
  if (typeof data.text === "string" && data.text.length > 0) return data.text;
  if (Array.isArray(data.tokens)) {
    return data.tokens.map((t) => t.text).join("");
  }
  return "";
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
    try {
      await fetch(`${API_BASE}/v1/transcriptions/${transcriptionId}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
    } catch {
      /* non-fatal */
    }
  }
  if (fileId) {
    try {
      await fetch(`${API_BASE}/v1/files/${fileId}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
    } catch {
      /* non-fatal */
    }
  }
}

export interface TranscribeCallbacks {
  /** Called as the flow progresses through stages. */
  onStage?: (stage: TranscribeStage) => void;
  /**
   * Called with the file id IMMEDIATELY after upload, then again with the
   * transcription id IMMEDIATELY after job creation, so the caller can persist
   * them for crash recovery.
   */
  onIds?: (ids: { fileId?: string; transcriptionId?: string }) => void;
  signal?: AbortSignal;
}

export interface TranscribeResult {
  transcript: string;
  fileId: string;
  transcriptionId: string;
}

/**
 * Full orchestrator: upload → create → poll → fetch. Emits stage + id events
 * along the way so callers can persist progress and recover from crashes.
 */
export async function transcribeBlob(
  blob: Blob,
  { onStage, onIds, signal }: TranscribeCallbacks = {},
): Promise<TranscribeResult> {
  onStage?.("uploading");
  const fileId = await uploadFile(blob, signal);
  onIds?.({ fileId });

  onStage?.("creating");
  const transcriptionId = await createTranscription(fileId, signal);
  onIds?.({ transcriptionId });

  onStage?.("polling");
  await pollTranscription(transcriptionId, signal);

  onStage?.("fetching");
  const transcript = await getTranscript(transcriptionId, signal);

  return { transcript, fileId, transcriptionId };
}

/**
 * Resume polling an EXISTING transcription id (from a previous session that was
 * interrupted mid-flight), then fetch its transcript. Used to recover items
 * that were left stranded in the "transcribing" state.
 */
export async function resumePoll(
  transcriptionId: string,
  signal?: AbortSignal,
): Promise<string> {
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
