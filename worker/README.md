# littlebird-voice Worker

Cloudflare Worker (Hono) serving the `/api/*` backend AND the built PWA
(static assets from `../dist`). One deploy, same origin, no CORS.

## Layout

- `wrangler.jsonc` — canonical config (JSONC, not TOML). All bindings live here.
- `migrations/` — numbered D1 migrations (`wrangler d1 migrations apply`).
- `src/index.ts` — Hono app + the single `queue()` handler
  (`src/queue/consumer.ts`).
- `src/memory/` — chunking, embedding/vector seams, ingest, hybrid search
  (section 30, see below).
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
# local seams for memory/AI (no Cloudflare account — see "Local dev seams"):
DEV_FAKE_AI=1
DEV_LOCAL_VECTOR=1
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
DLQ `littlebird-ingest-dlq`). The dispatcher lives in
`src/queue/consumer.ts` (`queueHandler`, wired as the app's single `queue()`
export in `src/index.ts`). Routing per `IngestMessage`:

- `kind: "document"`, or `jobs` includes `"index"` (or `jobs` omitted) →
  `ingestMemory()` (chunk → embed → vector upsert, see below);
- `kind: "transcript"` with `jobs` including `"summarize"` →
  `handleTranscriptAutoSummary()` (section 20).

Failures rethrow → per-message `retry()` → DLQ after 3 attempts. Malformed
messages and `ai_bad_output` errors are acked/dropped (retry can't help).

## Memory & semantic search (section 30)

- `migrations/0002_memory.sql` — `memory_documents`, `memory_chunks`, the
  FTS5 virtual table `memory_chunks_fts` (+ sync triggers), and the
  LOCAL-DEV-ONLY `memory_vectors_dev` table. Note: FTS5 tables break
  `wrangler d1 export` (documented in the migration header).
- `src/memory/chunking.ts` — speaker-turn transcript chunker + text chunker.
- `src/memory/ingest.ts` — `ingestMemory` / `deleteMemoryFor` /
  `reindexMemory` (revision-guarded, hash-diff idempotent).
- `src/memory/search.ts` — `searchMemory(env, userId, request)`: hybrid
  vector + FTS5 keyword search merged with reciprocal-rank fusion. Used
  directly by section 20's Ask-AI and wrapped by `POST /api/memory/search`.
- `src/routes/memory.ts` — `POST /api/memory/search`,
  `POST|GET|DELETE /api/memory/documents[...]`, `POST /api/memory/reindex`.

### Local dev seams (no Cloudflare account)

**Vectorize has NO local simulator in `wrangler dev`**, and declaring the
`ai`/`vectorize` bindings without account credentials breaks
vitest-pool-workers startup. Both bindings are therefore commented out in
`wrangler.jsonc`, `Env.AI`/`Env.VECTORIZE` are optional, and two env-var
gated seams stand in locally (set in `.dev.vars` and in
`vitest.config.ts`):

- `DEV_FAKE_AI=1` → `DevHashEmbeddingProvider` (`src/memory/provider.ts`):
  deterministic token-hash pseudo-embeddings, 1024 dims, no network.
- `DEV_LOCAL_VECTOR=1` → `DevD1MemoryIndex` (`src/memory/index-store.ts`):
  brute-force cosine over the `memory_vectors_dev` D1 table.

The deploy-ready implementations (`WorkersAiEmbeddingProvider` using
`@cf/baai/bge-m3`, `VectorizeMemoryIndex`) are selected automatically when
the real bindings exist.

### Deploy provisioning (memory)

Before the first deploy with memory enabled, uncomment the `ai` and
`vectorize` blocks in `wrangler.jsonc`, remove the `DEV_*` vars, and:

```bash
npx wrangler vectorize create littlebird-memory --dimensions=1024 --metric=cosine
npx wrangler vectorize create-metadata-index littlebird-memory --property-name=kind --type=string
npx wrangler vectorize create-metadata-index littlebird-memory --property-name=session_id --type=string
npx wrangler vectorize create-metadata-index littlebird-memory --property-name=created_at --type=number
```

Metadata indexes MUST exist before the first vector insert. Vectorize
mutations are async — newly upserted vectors may take a few seconds to
become queryable.
