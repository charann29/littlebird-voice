# littlebird-voice

An **offline-first** voice recording and transcription web app + installable PWA.

Most meeting/voice-notes tools stop working the moment you lose connectivity.
`littlebird-voice` is built the other way around: **recording never depends on the
network.**

- **Online** → live streaming transcription as you speak (Soniox realtime).
- **Offline** → you can still record. Audio is captured and queued locally in
  IndexedDB. When you're back online, transcribe the queued recordings (they can
  also drain automatically on reconnect).

Powered by [Soniox](https://soniox.com) speech-to-text (realtime `stt-rt-v5` +
async `stt-async-v5`), with English/Hindi/Telugu language hints.

---

## Features

- **Live tab** — real-time streaming transcription with an animated waveform,
  interim + finalized text, and speaker-aware output. Online only (needs a
  connection).
- **Recorder tab** — record audio via `MediaRecorder`. Works fully offline; the
  record button is never gated on connectivity. On stop, the recording is saved
  locally with status `pending`.
- **Recordings tab** — the local queue/history. Play back stored audio (works
  offline), transcribe pending items (async Soniox flow), copy transcripts, retry
  failures, and delete. A "back online — N ready to transcribe" banner and
  "Transcribe all pending" appear when you reconnect with a non-empty queue.
- **PWA** — installable, offline app-shell boot, prompt-based updates (never
  auto-reloads mid-recording).
- **Online/offline badge** driven by `navigator.onLine` + `online`/`offline`
  events (treated as a hint, not a hard guarantee — network ops still fail
  gracefully with readable errors).

---

## Prerequisites

- **Node.js ≥ 20** (developed on Node 22) and npm.
- A **Soniox API key** — create one at <https://console.soniox.com>.
- A **secure context** at runtime (HTTPS or `localhost`). `getUserMedia` and
  `crypto.randomUUID()` require it; opening the app over plain `http://` on a LAN
  IP will break recording.

---

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure your Soniox key
cp .env.example .env
# then edit .env and set:
#   VITE_SONIOX_API_KEY=<your-soniox-api-key>

# 3. Run the dev server (Live/Recorder/Recordings work here)
npm run dev            # http://localhost:5173
```

### Environment variables

| Variable                | Required | Description                                                        |
| ----------------------- | -------- | ------------------------------------------------------------------ |
| `VITE_SONIOX_API_KEY`   | yes      | Soniox API key. Used for both realtime and async transcription.    |

All configuration constants (API base URL, models, language hints, poll
interval/timeout, max recording length) live in [`src/config.ts`](src/config.ts).

---

## Scripts

| Command             | What it does                                              |
| ------------------- | -------------------------------------------------------- |
| `npm run dev`       | Vite dev server on port 5173.                            |
| `npm run build`     | Type-check (`tsc -b`) then production build to `dist/`.  |
| `npm run preview`   | Serve the production `dist/` build (port 4173).          |
| `npm run typecheck` | Type-check only (`tsc -b`).                              |

> **PWA note:** the service worker is intentionally **disabled under `npm run
> dev`** (`devOptions.enabled: false` in `vite.config.ts`). To exercise install,
> offline app-shell boot, and update behavior you must use a production build:
>
> ```bash
> npm run build && npm run preview   # then open http://localhost:4173
> ```

---

## Security: the API key is exposed in the client bundle

This MVP calls Soniox **directly from the browser**, so `VITE_SONIOX_API_KEY` is
inlined into the JavaScript bundle at build time (Vite inlines all `VITE_*` vars)
and is also precached by the service worker. **Anyone who loads the app can
extract the key** and use your Soniox account's quota/resources. A UI warning
does not mitigate this.

This is acceptable **only** for local/private/demo use with a disposable,
spend-capped key. **Do not deploy this build publicly with a real key.**

### Migration path to a secure deployment

The code is structured so this is a contained change:

- [`src/config.ts`](src/config.ts) is the single seam — `API_BASE` and the key.
- [`src/lib/soniox-async.ts`](src/lib/soniox-async.ts) centralizes all async REST
  calls (`authHeaders` + a single `sonioxFetch` helper).
- [`src/hooks/useSoniox.ts`](src/hooks/useSoniox.ts) holds the realtime client.

For a public deployment, front Soniox with a small serverless proxy (e.g. a
Cloudflare Worker) that holds the permanent key server-side: proxy the async
upload/create/poll/transcript/delete operations, and issue short-lived
**temporary keys** for the realtime WebSocket. Point `API_BASE` at the proxy and
switch `useSoniox` to fetch a temporary key on start. See
[`docs/soniox.md`](docs/soniox.md) for the exact request/response shapes.

---

## Testing offline behavior manually

The offline queue is the whole point of the app, so test it explicitly:

1. `npm run build && npm run preview`, open `http://localhost:4173`, and let the
   page fully load once (so the service worker installs and precaches the shell).
2. Open DevTools → **Network** → set throttling to **Offline** (or DevTools →
   **Application → Service Workers → Offline**). The badge should flip to amber
   **Offline**.
3. Go to the **Recorder** tab and record a few seconds. Recording still works;
   on stop it appears in **Recordings** as **Pending**.
4. On the **Recordings** tab, the **Transcribe** button is disabled with a
   "Connect to transcribe" hint. Playback still works (audio is local).
5. **Reload the page while still offline** — the app shell boots from cache and
   your pending recording is still in the list (persisted in IndexedDB, DB name
   `littlebird-voice`, store `recordings`).
6. Turn the network back **Online**. The badge flips to green, a "back online — N
   ready to transcribe" banner appears, and pending items can be transcribed
   (they also drain automatically on the `online` event).

To verify persistence: DevTools → **Application → IndexedDB → littlebird-voice →
recordings** shows the stored records (including the audio `Blob`).

---

## Architecture

```
src/
  config.ts              # Soniox config + app constants (the migration seam)
  types.ts               # Recording, RecordingStatus, TranscribeStage, SonioxTranscript
  App.tsx                # Shell: tabs, install/update banners, online badge, providers
  main.tsx               # Entry + prompt-based service-worker registration
  hooks/
    useOnlineStatus.ts   # navigator.onLine + online/offline events
    useSoniox.ts         # realtime streaming client (Live tab)
    useRecorder.ts       # MediaRecorder capture (works offline)
    useRecordings.tsx    # RecordingsProvider: queue state, transcribe orchestration, recovery
  lib/
    db.ts                # IndexedDB (idb) DAO for the recordings store
    soniox-async.ts      # async REST flow: upload → create → poll → transcript → cleanup
    waveform.ts          # canvas waveform visualizer (AudioContext / AnalyserNode)
  components/
    OnlineBadge.tsx  LiveTranscription.tsx  Recorder.tsx
    RecordingList.tsx  RecordingItem.tsx  icons.tsx
```

See [`docs/soniox.md`](docs/soniox.md) for the full Soniox integration reference.

---

## Tech stack

Vite 6 · React 19 · TypeScript (strict) · Tailwind CSS v4 · `vite-plugin-pwa`
(Workbox) · `idb` · `@soniox/speech-to-text-web`.
