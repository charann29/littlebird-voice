# Soniox integration reference

This app uses two Soniox surfaces:

- **Realtime** (Live tab) via the `@soniox/speech-to-text-web` SDK.
- **Async REST** (Recordings queue) via `fetch` in
  [`src/lib/soniox-async.ts`](../src/lib/soniox-async.ts).

Base URL and models are defined in [`src/config.ts`](../src/config.ts):

| Constant           | Value                       |
| ------------------ | --------------------------- |
| `API_BASE`         | `https://api.soniox.com`    |
| `RT_MODEL`         | `stt-rt-v5` (realtime)      |
| `ASYNC_MODEL`      | `stt-async-v5` (async)      |
| `LANGUAGE_HINTS`   | `["en", "hi", "te"]`        |
| `POLL_INTERVAL_MS` | `2000`                      |
| `POLL_TIMEOUT_MS`  | `300000` (5 min)            |

**Auth:** every request sends `Authorization: Bearer <VITE_SONIOX_API_KEY>`.

---

## Realtime (Live tab)

`src/hooks/useSoniox.ts` uses `SonioxClient` from `@soniox/speech-to-text-web`:

- Model `stt-rt-v5`, `languageHints: ["en", "hi", "te"]`, speaker diarization
  enabled.
- `start()` is async and is passed a single `stream` (a `MediaStream` the app
  owns and shares with the waveform `AnalyserNode`), so only one mic stream is
  opened.
- Termination: `stop()` for a graceful user stop (flushes buffered audio into
  final tokens, releases the stream in `onFinished`); `cancel()` for
  discard/unmount.
- Final tokens (`is_final`) are appended once per callback; the interim tail is
  recomputed from non-final tokens.

For a public deployment this must switch to **temporary keys**: the browser
requests a short-lived key from your proxy and passes it to the SDK, instead of
embedding the permanent key.

---

## Async REST flow (Recordings queue)

Implemented in `src/lib/soniox-async.ts`. The orchestrator `transcribeBlob(blob,
{ onStage, onIds, signal })` runs these steps and fires `onIds` immediately after
each id is known (so the caller can persist for crash recovery):

### 1. Upload the audio file

```
POST /v1/files
Content-Type: multipart/form-data
field "file" = <Blob>   # filename/extension derived from the blob's mimeType
```

Response returns the file id in the **`id`** field (not `file_id`).

### 2. Create the transcription job

```
POST /v1/transcriptions
Content-Type: application/json

{ "model": "stt-async-v5", "file_id": "<id from step 1>", "language_hints": ["en","hi","te"] }
```

Response returns the transcription object; use its **`id`**.

### 3. Poll for completion

```
GET /v1/transcriptions/{id}
```

`status` ∈ `queued` | `processing` | `completed` | `error`. Poll every
`POLL_INTERVAL_MS`; give up after `POLL_TIMEOUT_MS`. Any terminal status other
than `completed` is a failure (read `error_message` / `error_type`). The poll
signal is composed from `AbortSignal.timeout(POLL_TIMEOUT_MS)` and the caller's
signal via `AbortSignal.any`, so a hung job can never block forever.

### 4. Fetch the transcript

```
GET /v1/transcriptions/{id}/transcript
```

Returns `{ text, tokens }`. The app uses `text` (falls back to joining token
`text` values).

### 5. Best-effort cleanup (after success)

```
DELETE /v1/transcriptions/{id}
DELETE /v1/files/{fileId}
```

Failures here are swallowed (non-fatal).

---

## Recovery semantics

- `sonioxFileId` is persisted immediately after step 1; `sonioxTranscriptionId`
  immediately after step 2.
- On reload with an item stuck in `transcribing`: if a `sonioxTranscriptionId`
  exists, the app **resumes** via `resumePoll(transcriptionId)` (steps 3–4) rather
  than re-uploading; otherwise it resets the item to `pending`.
- `TranscriptionTerminalError` distinguishes a terminal job failure (clear ids so
  a retry starts clean) from a transient/abort error (keep ids so a retry resumes
  the same job).
- Deleting a recording mid-transcription tombstones the id, aborts the in-flight
  request, awaits it, then deletes locally and best-effort deletes the remote
  Soniox resources.

---

## Caching

The Workbox `runtimeCaching` rule makes all `https://api.soniox.com/*` GET
requests **`NetworkOnly`** — transcripts are never served from a stale cache.
POST/DELETE fall through to the network (Workbox routes are GET-only), and
WebSocket (realtime) traffic bypasses the service worker entirely.
