# littlebird-voice Worker

Cloudflare Worker (Hono) serving the `/api/*` backend AND the built PWA
(static assets from `../dist`). One deploy, same origin, no CORS.

## Layout

- `wrangler.jsonc` — canonical config (JSONC, not TOML). All bindings live here.
- `migrations/` — numbered D1 migrations (`wrangler d1 migrations apply`).
- `src/index.ts` — Hono app + (temporary no-op) queue handler.
- `src/auth.ts` — shared-bearer-token middleware (`c.var.userId`).
- `src/routes/` — one Hono sub-app per feature (`sessions.ts`, `soniox.ts`).
- `src/services/persistence.ts` — `saveTranscript` / `saveSummary`, the ONLY
  write paths for transcripts/summaries (atomic revision bump + INGEST_QUEUE
  publish).
- `src/services/ingest-message.ts` — canonical `IngestMessage` type.

## Local development (no Cloudflare account needed)

D1 and Queues run via wrangler's local simulators.

```bash
cd worker
npm install

# secrets for local dev (gitignored):
cat > .dev.vars <<EOF
SONIOX_API_KEY=<your soniox key>
APP_AUTH_TOKEN=<any shared secret, e.g. openssl rand -hex 16>
EOF

# apply migrations to the local D1 simulator:
npx wrangler d1 migrations apply littlebird-voice --local

# run the API on http://localhost:8787
npm run dev
```

Then in the repo root run `npm run dev` (Vite proxies `/api` →
`http://localhost:8787`).

Inspect local data:

```bash
npx wrangler d1 execute littlebird-voice --local \
  --command "SELECT id, title, status, transcript_revision FROM sessions"
```

## Tests

```bash
npm test          # vitest + @cloudflare/vitest-pool-workers (real local D1)
npm run typecheck
```

## Provision + deploy (when a Cloudflare account is wired up)

Queues are available on the Workers Free plan (since Feb 2026).

```bash
wrangler login                                # or CLOUDFLARE_API_TOKEN
wrangler d1 create littlebird-voice           # paste database_id into wrangler.jsonc
wrangler queues create littlebird-ingest
wrangler queues create littlebird-ingest-dlq
wrangler d1 migrations apply littlebird-voice --remote
wrangler secret put SONIOX_API_KEY
wrangler secret put APP_AUTH_TOKEN
npm --prefix .. run build                     # builds the PWA into ../dist
npm run deploy
```

## Auth

Every `/api/*` route except `GET /api/health` requires
`Authorization: Bearer <APP_AUTH_TOKEN>`. `GET /api/auth/check` returns 204
for a valid token (the Settings UI uses it to validate a pasted token).
Errors are always `{ "error": { "code": string, "message": string } }`.

## Queue consumer

`wrangler.jsonc` declares the `littlebird-ingest` consumer (max_retries 3,
DLQ `littlebird-ingest-dlq`), but the real dispatcher
(`src/queue/consumer.ts`) is owned by section 30. Until then `src/index.ts`
exports a no-op `queue()` handler so `wrangler dev` starts cleanly.
