# littlebird-voice

An **offline-first** voice recording and transcription web app + installable PWA,
backed by a single **Cloudflare Worker** (API + static assets) with **D1**
(SQLite) persistence and **Queues** for background ingest jobs.

Most meeting/voice-notes tools stop working the moment you lose connectivity.
`littlebird-voice` is built the other way around: **recording never depends on the
network.**

- **Online** → live streaming transcription as you speak (Soniox realtime, via
  short-lived temporary keys minted by the Worker).
- **Offline** → you can still record. Audio is captured and queued locally in
  IndexedDB. When you're back online, transcribe the queued recordings (they can
  also drain automatically on reconnect) and every change syncs durably to the
  server through a persisted outbox.

Powered by [Soniox](https://soniox.com) speech-to-text (realtime `stt-rt-v5` +
async `stt-async-v5`), with English/Hindi/Telugu language hints.

---

## Architecture (v2)

```
             browser (PWA, Vite + React)
             │  same-origin /api/* (bearer app token)
             ▼
┌──────────────────────────────────────────────┐
│ Cloudflare Worker (worker/) — Hono           │
│  • serves the built PWA (assets binding)     │
│  • /api/sessions CRUD + transcripts/summaries│
│  • /api/auth/soniox-token → temp realtime key│
│  • /api/stt/* → allow-listed Soniox relay    │
│  • D1 (littlebird-voice) + Queues (ingest)   │
└──────────────────────────────────────────────┘
```

- **No Soniox key in the client.** The permanent `SONIOX_API_KEY` lives only as a
  Worker secret. The Live tab fetches a short-lived single-use temporary key from
  `POST /api/auth/soniox-token`; the async flow goes through the `/api/stt/*`
  relay, which injects the key server-side.
- **Auth:** a single shared bearer token (`APP_AUTH_TOKEN` Worker secret). Paste
  it once in the app header ("Set token"); it is stored in
  `localStorage("lb.apiToken")` and validated against `GET /api/auth/check`.
- **Durable sync (outbox):** every upsert/delete intent is persisted in the
  `syncOutbox` IndexedDB store *atomically* with the local mutation (one
  transaction spanning both stores), then drained to the Worker on hydration, on
  `online` events, and whenever the token is set/changed. Ops are removed only
  after the server acknowledges (2xx, or 404 on delete). Deleting a recording
  offline removes the local row immediately; the remote-deletion tombstone stays
  queued until acknowledged. The header shows a "Synced / n pending" badge.

```
src/
  config.ts              # app constants; API_BASE points at the /api/stt relay
  types.ts               # Recording, TranscriptSegment, SyncOp, SyncState, ...
  App.tsx                # Shell: tabs, token entry, banners, badges, providers
  hooks/
    useSoniox.ts         # realtime client; mints temp keys via the Worker
    useRecorder.ts       # MediaRecorder capture (works offline)
    useRecordings.tsx    # queue state, transcribe orchestration, sync kicks
  lib/
    api.ts               # apiFetch + token storage/subscription
    api-types.ts         # API request/response types (shared vocabulary)
    db.ts                # IndexedDB v2: recordings + syncOutbox, atomic methods
    sync.ts              # drainOutbox: outbox → PUT/DELETE /api/sessions
    soniox-async.ts      # async REST flow via the relay; diarized segments
worker/
  src/index.ts           # Hono app: auth, routes, assets fallback, queue stub
  src/routes/            # sessions CRUD, soniox token mint + relay
  src/services/          # persistence (saveTranscript/saveSummary), IngestMessage
  migrations/0001_init.sql
```

---

## Prerequisites

- **Node.js ≥ 20** (developed on Node 22) and npm.
- A **Soniox API key** — create one at <https://console.soniox.com> (kept
  server-side only).
- A **secure context** at runtime (HTTPS or `localhost`). `getUserMedia` and
  `crypto.randomUUID()` require it.

---

## Local development (two terminals)

```bash
# 0. Install dependencies (root + worker)
npm install
npm --prefix worker install

# 1. Worker secrets for local dev
cp worker/.dev.vars.example worker/.dev.vars
# edit worker/.dev.vars:
#   SONIOX_API_KEY=<your-soniox-api-key>
#   APP_AUTH_TOKEN=<any-shared-token-you-choose>

# 2. Apply D1 migrations to the local simulator
cd worker && npx wrangler d1 migrations apply littlebird-voice --local && cd ..

# terminal 1 — the Worker (API on http://localhost:8787)
npm --prefix worker run dev

# terminal 2 — the PWA with HMR (proxies /api → 8787)
npm run dev            # http://localhost:5173
```

Open the app, click **Set token** in the header, and paste the same value you
put in `APP_AUTH_TOKEN`. Live transcription and server sync now work; recording
itself never needs any of this.

---

## Scripts

| Command                        | What it does                                             |
| ------------------------------ | -------------------------------------------------------- |
| `npm run dev`                  | Vite dev server on port 5173 (proxies `/api` → 8787).    |
| `npm run build`                | Type-check (`tsc -b`) then production build to `dist/`.  |
| `npm run preview`              | Serve the production `dist/` build (port 4173).          |
| `npm run typecheck`            | Type-check only (`tsc -b`).                              |
| `npm test`                     | Frontend unit/component tests (vitest + jsdom).          |
| `npm run deploy`               | Build the PWA, then `wrangler deploy` the Worker.        |
| `npm --prefix worker run dev`  | `wrangler dev` (local D1 + Queues simulators).           |
| `npm --prefix worker run test` | Worker tests (`@cloudflare/vitest-pool-workers`).        |

> **PWA note:** the service worker is intentionally **disabled under `npm run
> dev`**. To exercise install, offline app-shell boot, and update behavior use a
> production build: `npm run build && npm run preview`.

---

## Provisioning + deploy (Cloudflare)

Everything in this repo also runs fully locally under `wrangler dev`; deploying
is optional. To ship for real:

```bash
cd worker

# one-time provisioning
npx wrangler d1 create littlebird-voice        # paste the id into wrangler.jsonc
npx wrangler queues create littlebird-ingest
npx wrangler queues create littlebird-ingest-dlq
npx wrangler d1 migrations apply littlebird-voice --remote

# secrets
npx wrangler secret put SONIOX_API_KEY
npx wrangler secret put APP_AUTH_TOKEN

# deploy PWA + API as one Worker
cd .. && npm run deploy
```

Secrets list: `SONIOX_API_KEY` (permanent Soniox key, server-side only),
`APP_AUTH_TOKEN` (shared bearer token the PWA sends on every `/api/*` request).
See [`worker/README.md`](worker/README.md) for details.

---

## Testing offline behavior manually

1. `npm run build && npm run preview`, open `http://localhost:4173`, and let the
   page fully load once (so the service worker installs and precaches the shell).
2. DevTools → **Network** → **Offline**. The badge flips to amber **Offline**.
3. **Recorder** tab: record a few seconds — it appears in **Recordings** as
   **Pending**, and an upsert op is queued in the outbox (badge shows pending).
4. **Reload while still offline** — the shell boots from cache; the recording and
   its queued sync ops persist (IndexedDB `littlebird-voice`, stores
   `recordings` + `syncOutbox`).
5. Go back **Online** — pending items transcribe and the outbox drains; the
   badge returns to **Synced**. Deleting while offline works the same way: the
   local row disappears instantly and the server row is deleted once online.

---

## Tech stack

Vite 6 · React 19 · TypeScript (strict) · Tailwind CSS v4 · `vite-plugin-pwa`
(Workbox) · `idb` · `@soniox/speech-to-text-web` · Hono · Cloudflare Workers
(D1, Queues, static assets) · Vitest (+ jsdom, fake-indexeddb,
`@cloudflare/vitest-pool-workers`).
