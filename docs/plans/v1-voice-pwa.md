# littlebird-voice — Detailed Implementation Plan (v1: Web + PWA)

## Proposed repo name
`littlebird-voice` — new repo under `charann29`. Do NOT reuse `pharmacy-image-search`.
Alternatives considered: `voicebird`, `echobird`, `birdscribe`. Recommendation stands with `littlebird-voice` (clear lineage to the inspiration + "voice" differentiator).

---

## Product / spec layer

### Goal
A single installable PWA that transcribes voice. Differentiator vs littlebird.ai: **the recording feature stays fully usable offline.** Online = live streaming transcription. Offline = record now, queue locally, transcribe later (one click) when back online.

### Users
- Individuals who want quick multilingual (English / Hindi / Telugu) voice-to-text.
- Users on flaky / no connectivity who still need to capture audio and get transcripts once reconnected.

### Core behaviors (acceptance criteria)
1. **Live transcription (online only):** mic → Soniox realtime WebSocket → live partial/final tokens, waveform, editable transcript text. (AC: speaking produces streaming text; final text is editable/copyable.)
2. **Offline recording (must work with `navigator.onLine === false`):** the record button and full recording UI (timer, waveform) are available and functional offline. Audio captured to a Blob. (AC: with DevTools set to Offline, the user can still start/stop a recording and it is saved.)
3. **Local queue (IndexedDB):** every recording (Blob + metadata) persists in IndexedDB and survives reload/close. (AC: reload after recording → recording still present with correct status.)
4. **Online/offline detection:** a visible Online/Offline badge driven by `navigator.onLine` + `online`/`offline` events. (AC: toggling network flips the badge live.)
5. **Transcribe-when-online:** each pending recording has a "Transcribe" button, enabled only when online, that runs the Soniox async flow and stores the transcript. A "Transcribe all pending" action runs them sequentially. Progress, error, and retry are surfaced per item. (AC: online + click → status goes pending→transcribing→done with transcript text; error path sets status=error with a retry option.)
6. **History view:** list of recordings with audio playback, transcript display, copy, and delete. (AC: playback plays the stored Blob; delete removes from IndexedDB and UI.)
7. **PWA:** web manifest (name, icons, theme, `display: standalone`) + service worker (vite-plugin-pwa / Workbox) precaching the app shell so the app loads with no network; install prompt handling. (AC: after first load, going offline and reloading still boots the app; browser offers "Install".)

### Non-goals (this phase)
- No browser extension, no desktop/mobile native app.
- No per-site injection / "works on all websites" content scripts — standalone PWA only.
- No auth, no multi-user accounts, no cloud sync of recordings (local-only storage).
- No summarization/LLM features (littlebird's summary feature is out of scope for v1).
- No backend server (client-side only MVP — see security caveat).

### Security caveat (must ship in README + UI note)
The Soniox API key is exposed to the browser via `VITE_SONIOX_API_KEY` (Vite inlines `VITE_*` at build time). This matches the reference implementation and is acceptable for this MVP/demo. **Documented follow-up (not built now):** a lightweight serverless proxy (e.g. Cloudflare Worker) that holds the key server-side and signs/relays realtime + async requests, so the key never reaches the client. Plan leaves a `lib/soniox-async.ts` seam (single `API_BASE` constant + auth header builder) so switching to a proxy later is a one-file change.

---

## Verified Soniox integration details

Auth for all REST + realtime calls: `Authorization: Bearer <VITE_SONIOX_API_KEY>`.
Base URL: `https://api.soniox.com`.

### Realtime (online live) — `@soniox/speech-to-text-web`
- Package: `@soniox/speech-to-text-web` `^1.4.0` (same as reference).
- `new SonioxClient({ apiKey, onStarted, onPartialResult, onFinished, onError })`.
- `.start({ model: "stt-rt-v5", languageHints: ["en","hi","te"], enableSpeakerDiarization: true })`.
- `.stop()` to end.
- Tokens arrive via `onPartialResult(result.tokens[])`; each token `{ text, is_final }`. (Verbatim port of reference `useSoniox.ts`.)

### Async (offline-recorded audio, transcribe-when-online) — REST, verified against soniox.com/docs/stt/async/async-transcription (checked 2026-07-20)
Model: **`stt-async-v5`** (current active async model as of 2026-07; `stt-async-v4`/`v3` auto-route but v5 is current). `language_hints: ["en","hi","te"]`.

1. **Upload file** — `POST https://api.soniox.com/v1/files`
   - `multipart/form-data`, form field name `file` (the recorded Blob).
   - Response JSON returns the file id in the **`id`** field (NOT `file_id`). Use `res.id` as the `file_id` below.
2. **Create transcription** — `POST https://api.soniox.com/v1/transcriptions`
   - JSON body: `{ "model": "stt-async-v5", "file_id": "<id from step 1>", "language_hints": ["en","hi","te"] }`.
   - Response returns the transcription object; use its **`id`**.
3. **Poll** — `GET https://api.soniox.com/v1/transcriptions/{id}`
   - `status` ∈ `"queued" | "processing" | "completed" | "error"`. On `"error"`, read `error_type` + `error_message`. Poll interval ~2s (backoff-friendly).
4. **Get transcript** — `GET https://api.soniox.com/v1/transcriptions/{id}/transcript`
   - Response `{ id, text, tokens: [{ text, start_ms, end_ms, confidence, speaker }] }`. Store `text` (join tokens if `text` absent).
5. **Cleanup (optional, best-effort after success):** `DELETE /v1/transcriptions/{id}` and `DELETE /v1/files/{fileId}` to avoid accumulating server-side artifacts. Failures here are non-fatal.

Uncertainty notes: field name on upload is `id` (confirmed in docs' Python example `res.json()["id"]`); status enum uses `"error"` (docs API spec) though some SDK text says `"failed"` — code must treat any non-`completed`/non-`queued`/non-`processing` terminal status as failure and surface `error_message`. Model name `stt-async-v5` verified current on soniox.com/docs/stt/models (2026-07-20).

---

## Tech stack (match reference)
- Vite 6 + React 19 + TypeScript.
- Tailwind CSS v4 via `@tailwindcss/vite`.
- `@soniox/speech-to-text-web` (realtime).
- **Add:** `idb` (IndexedDB wrapper), `vite-plugin-pwa` (+ Workbox, bundled).
- No router lib needed — single page with a two-tab local state switch (Live / Recordings). Keep minimal.

---

## File / folder structure

```
littlebird-voice/
├── index.html                     # app entry; theme-color meta, mount point
├── package.json                   # deps + scripts (dev/build/preview)
├── vite.config.ts                 # react + tailwind + VitePWA plugins
├── tsconfig.json                  # ported from reference
├── tsconfig.node.json             # for vite.config typing (VitePWA needs it)
├── .env.example                   # VITE_SONIOX_API_KEY=
├── .gitignore                     # node_modules, dist, .env
├── README.md                      # setup, env, security caveat, offline test steps
├── public/
│   ├── favicon.svg
│   └── icons/
│       ├── pwa-192.png            # 192x192
│       ├── pwa-512.png            # 512x512
│       ├── maskable-512.png       # 512x512 maskable
│       └── apple-touch-icon.png   # 180x180
└── src/
    ├── main.tsx                   # React root; registers PWA update via virtual:pwa-register
    ├── App.tsx                    # layout, tab switch (Live|Recordings), OnlineBadge, RecordingsProvider
    ├── index.css                  # @import "tailwindcss"; dark theme base
    ├── vite-env.d.ts              # env typing + vite-plugin-pwa/client + soniox module ref
    ├── config.ts                  # API_BASE, RT_MODEL, ASYNC_MODEL, LANGUAGE_HINTS, POLL_INTERVAL_MS
    ├── types.ts                   # Recording, RecordingStatus, SonioxTranscript types
    ├── lib/
    │   ├── db.ts                  # idb: open DB, schema, DAO (add/get/getAll/update/delete)
    │   ├── soniox-async.ts        # uploadFile/createTranscription/pollTranscription/getTranscript/transcribeBlob orchestrator + auth header
    │   └── waveform.ts            # shared canvas draw helper (extracted from reference)
    ├── hooks/
    │   ├── useOnlineStatus.ts     # navigator.onLine + online/offline events → boolean
    │   ├── useSoniox.ts           # realtime live transcription (ported from reference)
    │   ├── useRecorder.ts         # MediaRecorder capture → Blob, timer, live waveform
    │   └── useRecordings.ts       # context hook: list + CRUD backed by db.ts, transcribe actions
    └── components/
        ├── OnlineBadge.tsx        # Online/Offline pill
        ├── LiveTranscription.tsx  # online live view (reference UI, disabled/steer when offline)
        ├── Recorder.tsx           # offline-capable record UI (mic btn, timer, waveform, save)
        ├── RecordingList.tsx      # history/queue; "Transcribe all pending" button
        ├── RecordingItem.tsx      # per-item: audio playback, status, transcript, transcribe/copy/delete/retry
        └── icons.tsx              # Mic/Stop/Send/Copy/Trash/Wifi icons
```

### Key type definitions (`src/types.ts`)
```ts
export type RecordingStatus = "pending" | "transcribing" | "done" | "error";

export interface Recording {
  id: string;              // crypto.randomUUID()
  createdAt: number;       // Date.now()
  durationMs: number;
  mimeType: string;        // e.g. "audio/webm;codecs=opus"
  blob: Blob;              // stored directly in IndexedDB
  status: RecordingStatus;
  transcript: string | null;
  error: string | null;
  sonioxFileId: string | null;
  sonioxTranscriptionId: string | null;
}
```

### IndexedDB schema (`src/lib/db.ts`)
- DB name `littlebird-voice`, version `1`.
- Store `recordings`, `keyPath: "id"`.
- Indexes: `by-createdAt` (createdAt), `by-status` (status).
- DAO signatures:
  ```ts
  export function getDB(): Promise<IDBPDatabase<Schema>>;
  export function addRecording(r: Recording): Promise<void>;
  export function getRecording(id: string): Promise<Recording | undefined>;
  export function getAllRecordings(): Promise<Recording[]>;      // sorted desc by createdAt
  export function updateRecording(id: string, patch: Partial<Recording>): Promise<void>;
  export function deleteRecording(id: string): Promise<void>;
  ```
- Blobs are stored directly (structured-clone supports Blob). This is independent of the service-worker cache, so recordings survive SW updates.

### State management
React Context (`RecordingsProvider`) holding an in-memory `Recording[]` mirror hydrated from IndexedDB on mount. `useRecordings()` exposes `{ recordings, addFromBlob, transcribeOne, transcribeAllPending, remove, refresh }`. Every mutation writes IndexedDB via `db.ts` then updates local state. No external state lib — keeps it minimal. Live transcription state stays local to `useSoniox` (not persisted).

### Online/offline handling (`src/hooks/useOnlineStatus.ts`)
```ts
export function useOnlineStatus(): boolean; // init navigator.onLine; add/remove online/offline listeners
```
- `OnlineBadge` shows green "Online" / amber "Offline".
- `LiveTranscription`: mic disabled + banner "Live transcription needs a connection — record offline instead" when offline.
- `Recorder`: never gated on online (getUserMedia + MediaRecorder are local).
- `RecordingItem` Transcribe button + `Transcribe all pending`: `disabled={!online}` with tooltip.

### Offline recorder (`src/hooks/useRecorder.ts`)
- `getUserMedia({ audio: true })` → `MediaRecorder(stream, { mimeType })`. Prefer `"audio/webm;codecs=opus"`, fall back via `MediaRecorder.isTypeSupported` (Safari → `"audio/mp4"`).
- Collect `dataavailable` chunks → `new Blob(chunks, { type })` on stop.
- Timer via `setInterval` (elapsed ms). Live waveform via shared `waveform.ts` + AnalyserNode (same technique as reference `useSoniox`).
- Returns `{ isRecording, elapsedMs, error, start, stop, canvasRef }`; `stop()` resolves to `{ blob, durationMs, mimeType }`.

### Async orchestrator (`src/lib/soniox-async.ts`)
```ts
const API_BASE = "https://api.soniox.com";
function authHeaders(): HeadersInit;                              // Bearer VITE_SONIOX_API_KEY
export async function uploadFile(blob: Blob): Promise<string>;   // POST /v1/files (FormData "file") → res.id
export async function createTranscription(fileId: string): Promise<string>; // POST /v1/transcriptions → res.id
export async function pollTranscription(id: string, signal?): Promise<void>; // GET loop until completed | throw on error
export async function getTranscript(id: string): Promise<string>;// GET /v1/transcriptions/{id}/transcript → text
export async function transcribeBlob(
  blob: Blob,
  onStage?: (s: "uploading"|"creating"|"polling"|"fetching") => void,
): Promise<{ transcript: string; fileId: string; transcriptionId: string }>;
// best-effort cleanup DELETEs after success
```
`useRecordings.transcribeOne` sets status `transcribing` → runs `transcribeBlob` → on success `{ status: "done", transcript, sonioxFileId, sonioxTranscriptionId }`; on throw `{ status: "error", error: message }`. `transcribeAllPending` runs sequentially over `status === "pending"` items.

### PWA config (`vite.config.ts` + manifest)
```ts
import { VitePWA } from "vite-plugin-pwa";
VitePWA({
  registerType: "autoUpdate",
  includeAssets: ["favicon.svg", "icons/apple-touch-icon.png"],
  manifest: {
    name: "littlebird-voice",
    short_name: "Voice",
    description: "Record and transcribe voice — online live, offline queued.",
    theme_color: "#020617",       // slate-950
    background_color: "#020617",
    display: "standalone",
    start_url: "/",
    icons: [
      { src: "icons/pwa-192.png", sizes: "192x192", type: "image/png" },
      { src: "icons/pwa-512.png", sizes: "512x512", type: "image/png" },
      { src: "icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  },
  workbox: {
    globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],  // precache app shell
    navigateFallback: "/index.html",                      // SPA offline boot
    runtimeCaching: [
      { urlPattern: /^https:\/\/api\.soniox\.com\/.*/i, handler: "NetworkOnly" }, // never cache transcription
    ],
  },
})
```
- `main.tsx` calls `registerSW({ immediate: true })` from `virtual:pwa-register`.
- `vite-env.d.ts` adds `/// <reference types="vite-plugin-pwa/client" />`.
- App shell (JS/CSS/HTML/icons) is precached → app boots offline. Transcription is NetworkOnly and simply fails gracefully offline (button disabled anyway).

---

## Build task breakdown (numbered, grouped for parallelism)

> Task 1 must complete first (scaffold). Tasks 2, 3, 4 are then parallel vertical slices. Task 5 integrates + PWA. Task 6 is docs/tests.

### Task 1 — Project scaffold & shared foundation  `[first]`
Create the repo skeleton and everything downstream depends on.
- `package.json` (deps: react, react-dom, @soniox/speech-to-text-web, idb; dev: vite, @vitejs/plugin-react, tailwindcss, @tailwindcss/vite, vite-plugin-pwa, typescript, @types/react, @types/react-dom), scripts `dev`/`build` (`tsc -b && vite build`)/`preview`.
- `index.html`, `tsconfig.json`, `tsconfig.node.json`, `vite.config.ts` (react + tailwind + VitePWA), `.env.example` (`VITE_SONIOX_API_KEY=`), `.gitignore`, `src/main.tsx`, `src/index.css` (`@import "tailwindcss";` + dark base), `src/vite-env.d.ts`, `src/config.ts` (API_BASE, RT_MODEL=`stt-rt-v5`, ASYNC_MODEL=`stt-async-v5`, LANGUAGE_HINTS=`["en","hi","te"]`, POLL_INTERVAL_MS=2000), `src/types.ts`, `src/components/icons.tsx`, `src/lib/waveform.ts` (extracted draw helper).
- Placeholder `App.tsx` rendering the two-tab shell + `OnlineBadge` slot so the app runs.
- Generate placeholder PWA icons in `public/icons/` (solid-color PNGs at required sizes; real design comes via the design handoff).
**Test:** `npm install && npm run build` succeeds; `npm run dev` serves a blank shell.

### Task 2 — Live transcription slice (online)  `[after 1] [parallel]`
- `src/hooks/useSoniox.ts` — port reference hook (model `stt-rt-v5`, languageHints `["en","hi","te"]`, diarization). Use shared `waveform.ts`.
- `src/hooks/useOnlineStatus.ts` + `src/components/OnlineBadge.tsx`.
- `src/components/LiveTranscription.tsx` — reference chat/input UI; when offline, disable mic + show steer banner.
**Test:** online, speaking streams live tokens into editable text; offline, mic is disabled with banner; badge reflects state (toggle DevTools Offline).

### Task 3 — Offline recorder + IndexedDB queue slice  `[after 1] [parallel]`
- `src/lib/db.ts` — idb schema + DAO.
- `src/hooks/useRecorder.ts` — MediaRecorder capture, timer, waveform.
- `src/hooks/useRecordings.ts` + `RecordingsProvider` context (list hydrate + CRUD; transcribe actions stubbed to call Task 4's orchestrator).
- `src/components/Recorder.tsx` — record UI usable offline; on stop, `addFromBlob` persists to IndexedDB.
**Test:** with DevTools Offline, record → stop → item appears with status `pending`; reload → item persists; playback works.

### Task 4 — Async transcription orchestrator slice  `[after 1] [parallel]`
- `src/lib/soniox-async.ts` — `uploadFile`/`createTranscription`/`pollTranscription`/`getTranscript`/`transcribeBlob` (+ best-effort cleanup) using verified endpoints/model.
**Test (integration, run after Task 3 wiring):** with a real recording online, `transcribeBlob` returns transcript text; forced error (e.g. bad key) throws a readable message. Unit-check status handling for `queued/processing/completed/error`.

### Task 5 — History view, transcribe wiring & PWA integration  `[after 2,3,4]`
- `src/components/RecordingList.tsx` (+ "Transcribe all pending") and `src/components/RecordingItem.tsx` (playback, status chip, transcript, Transcribe/Copy/Delete/Retry; Transcribe gated on `useOnlineStatus`).
- Wire `useRecordings.transcribeOne/transcribeAllPending` to `soniox-async.transcribeBlob` with per-item stage/progress + error/retry.
- Finalize `App.tsx` tabs (Live | Recordings) + `OnlineBadge`; wrap in `RecordingsProvider`.
- Confirm `vite.config.ts` VitePWA manifest + Workbox precache + NetworkOnly for `api.soniox.com`; `registerSW` in `main.tsx`.
**Test:** online + Transcribe → status `pending→transcribing→done` with transcript; "Transcribe all pending" processes queue; error → status `error` + Retry; after first load, go Offline and reload → app shell still boots (SW precache); browser shows Install prompt.

### Task 6 — README, env docs & manual test script  `[after 5]`
- `README.md`: setup, `VITE_SONIOX_API_KEY` env (Settings→Secrets / `.env`), security caveat + future proxy note, and the offline test procedure.
- Add a short `docs/` or README section: how to simulate offline (DevTools → Network → Offline / Application → Service Workers → Offline), verify IndexedDB persistence (Application → IndexedDB → `littlebird-voice`), and verify async transcription end-to-end.
**Test:** `npm run build && npm run preview`; follow the documented offline procedure end-to-end.

---

## Env / secrets
- `VITE_SONIOX_API_KEY` — already configured in this environment (and as an account secret). Add to `.env` for local dev and to the deploy target's env. It is inlined at build time (client-exposed — see caveat).

## Testing approach (summary)
- **Simulate offline:** Chrome DevTools → Network tab → "Offline", or Application → Service Workers → "Offline". Verify Recorder still records and the Online badge flips.
- **Queue persistence:** record offline, then reload / fully close+reopen the tab; confirm the recording and its `pending` status remain (Application → IndexedDB → `littlebird-voice` → `recordings`).
- **Async transcription:** go online, click Transcribe on a pending item; confirm status transitions and transcript text; test error path with an invalid key to confirm graceful `error` + Retry.
- **PWA offline boot:** load once online, then set Offline and reload; app shell must render. Confirm installability (address-bar install icon / `beforeinstallprompt`).
- **Build gate:** `npm run build` (runs `tsc -b`) must pass with no type errors before each slice is considered done.

## Traceability (AC → task)
AC1 Live → T2 · AC2 Offline record → T3 · AC3 IndexedDB queue → T3 · AC4 Online/offline detection → T2 (badge) + T5 (gating) · AC5 Transcribe-when-online → T4 + T5 · AC6 History → T5 · AC7 PWA → T1 (config) + T5 (verify).
