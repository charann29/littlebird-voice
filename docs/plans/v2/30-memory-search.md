# 30 — Memory & Semantic Search

Section of the littlebird-ai v2 plan. Depends on 10-backend-foundation (Cloudflare Worker, D1 `env.DB`, auth `user_id`, tables `sessions`/`transcripts`/`summaries`, REST base `/api/*`). Consumed by 20-ai-features (Ask-AI retrieval imports `searchMemory()` from `worker/src/memory/search.ts`; `POST /api/memory/search` wraps the same function) and 40-integrations-capture (pushes external docs via `POST /api/memory/documents` using the shared `MemoryDocumentInput`).

## Product / spec summary

**Goal:** every finished session (transcript + summary) and every imported external document becomes searchable memory. One search API powers (a) Ask-AI cross-session retrieval and (b) the ⌘K command palette, which shows semantic chunks with relevance scores alongside plain keyword session matches.

**Acceptance criteria**
1. After a transcript or summary is saved server-side, its content is chunked, embedded, and searchable within seconds (async, non-blocking to the save request).
2. `POST /api/memory/search` returns scored chunks with metadata (session/document, `session_title`, kind, speaker, timestamps) filtered by `kind`, `session_id`, and date range; results are scoped to the authenticated `user_id` only. The same logic is exported as a typed module function `searchMemory(env, userId, request)` that section 20's Ask-AI calls directly (no HTTP hop) — per-result `session_title` + `created_at` give it citation data.
3. Search works for English, Hindi, and Telugu queries against transcripts in any of those languages (multilingual embeddings).
4. Keyword fallback: exact/term matches missed by the vector index (names, IDs, rare terms) still surface via D1 full-text search, merged into one ranked list; the response also includes keyword-matched session titles for the palette.
5. Re-transcribing or regenerating a summary replaces its memory chunks (no stale duplicates). Deleting a session deletes all its vectors and chunk rows. Deleting a document does the same.
6. External documents ingest through the same pipeline via `POST /api/memory/documents` using the shared `MemoryDocumentInput` contract `{title, source, text, external_id?, metadata?}` (section 40 aligns to this shape); re-POST with the same `(source, external_id)` updates the existing document idempotently.
7. Frontend exposes `useMemorySearch` (debounced, abortable, offline-aware) as the data layer for the palette.

**Non-goals:** palette UI (designed separately), Ask-AI prompt/answer generation (20-ai-features), audio search, reranking models, cross-user/team memory.

**Edge cases handled:** empty query (no-op), offline client (hook returns disabled state), transcript with no diarization (single-speaker chunking), very short texts (<1 chunk), embedding call failure (chunk rows persist with `embedded_at IS NULL`; keyword search still works; queue retry + reindex endpoint recover), out-of-order completion of concurrent re-ingests (guarded by `sourceRevision`), Vectorize eventual consistency (freshly ingested chunks may lag queries by a few seconds — acceptable).

## Architecture

### Embedding + vector store: Workers AI bge-m3 + Vectorize (default), behind a seam

- **Embedding model: `@cf/baai/bge-m3`** on Workers AI. 1024-dim dense vectors, 100+ languages — this is the deciding factor: transcripts are en/hi/te (`LANGUAGE_HINTS` in `src/config.ts`), and `bge-base-en-v1.5` is English-only. Price ~$0.012/M input tokens; free tier covered by the Workers AI daily neuron allocation.
- **Vector store: Cloudflare Vectorize.** Index `littlebird-memory`, `dimensions=1024`, `metric=cosine`. Zero extra infra, native Worker binding, metadata filtering, namespaces.
- **Tenancy: Vectorize namespace = `user_id`.** Hard partition per user (free tier allows 1,000 namespaces/index); every query passes `namespace`, so cross-tenant leakage is structurally impossible. Metadata filters handle everything else.
- **Vector ID (deterministic, enables idempotent upsert):** `${parentId}:${kind}:${chunkIndex}`. Canonical identity: `parentId` = **session id for BOTH `transcript` and `summary` kinds** (the `kind` segment distinguishes them) and document id for `document` kind. Summary rows in the `summaries` table are never addressed by their own row id in memory. Re-ingesting the same content overwrites in place.
- **Metadata per vector** (≤10 KiB limit; we stay tiny — canonical text lives in D1, not metadata): `{ user_id, kind: "transcript"|"summary"|"document", session_id?, document_id?, created_at (unix s), speaker?, start_ms?, end_ms? }`.
- **Metadata indexes** (must be created before first insert; max 10, 64-byte indexed values): `kind` (string), `session_id` (string), `created_at` (number). `user_id` needs no index — namespaces handle it.
- **Provider seam:** `EmbeddingProvider` interface in the Worker — `{ modelId: string; dimensions: number; embed(texts: string[]): Promise<number[][]> }` — with `WorkersAiEmbeddingProvider` as the only implementation now. Store `modelId` on each chunk row so a future provider swap can detect and reindex stale vectors. Vector-store access goes through a thin `MemoryIndex` wrapper (`upsert`, `query`, `deleteByIds`) so Vectorize could be swapped for pgvector/Pinecone later without touching the pipeline.

### D1 chunk registry + FTS5 (keyword fallback, deletion, canonical text)

New table `memory_chunks` (one row per vector; source of truth for chunk text and for "which vector IDs belong to session X"):

```sql
CREATE TABLE memory_chunks (
  id TEXT PRIMARY KEY,            -- == Vectorize vector id
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('transcript','summary','document')),
  session_id TEXT,                -- FK sessions.id when kind IN ('transcript','summary');
                                  -- (session_id, kind) is the chunk-set identity — summary
                                  -- chunks are keyed by session id + kind='summary', never by
                                  -- the summaries row id, so no separate source_id column is
                                  -- needed (kind already disambiguates; session_id is not overloaded)
  document_id TEXT,               -- FK memory_documents.id when kind = 'document'
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  speaker TEXT,
  start_ms INTEGER, end_ms INTEGER,
  content_hash TEXT NOT NULL,     -- sha-256 of text, skip re-embed when unchanged
  source_revision INTEGER NOT NULL DEFAULT 0, -- revision of the parent content this chunk came from
  embedding_model TEXT,
  embedded_at INTEGER,            -- NULL = not yet in Vectorize
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_memory_chunks_session ON memory_chunks(session_id);
CREATE INDEX idx_memory_chunks_document ON memory_chunks(document_id);
CREATE INDEX idx_memory_chunks_user ON memory_chunks(user_id, created_at);

CREATE TABLE memory_documents (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'upload',   -- e.g. "notion", "web", "upload"
  external_id TEXT,               -- caller's stable id (e.g. Notion page id); NULL for one-off uploads
  metadata_json TEXT,             -- JSON blob: { url?, author?, ... } — page URL lives here
  revision INTEGER NOT NULL DEFAULT 0,  -- bumped on every upsert; sent as sourceRevision
  chunk_count INTEGER NOT NULL DEFAULT 0, -- persisted by the queue consumer after ingest
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
-- idempotency: one document per (user, source, external_id)
CREATE UNIQUE INDEX idx_memory_documents_external
  ON memory_documents(user_id, source, external_id) WHERE external_id IS NOT NULL;

CREATE VIRTUAL TABLE memory_chunks_fts USING fts5(
  text, content='memory_chunks', content_rowid='rowid'
);
-- + INSERT/UPDATE/DELETE triggers keeping fts in sync
```

D1 supports FTS5 (lowercase `fts5` required). Default `unicode61` tokenizer handles Hindi/Telugu because both scripts are whitespace-separated. Known caveat: `wrangler d1 export` fails on DBs containing FTS5 virtual tables — note in the migration README (drop/recreate virtual table around exports).

### Chunking strategy (diarized transcripts)

Pure function `chunkTranscript(tokens | text, opts)`:
- **Unit = speaker turn.** Group Soniox tokens (shape: `{text, start_ms, end_ms, speaker}` — see `src/lib/soniox-async.ts` `SonioxTranscript`) into consecutive same-speaker turns.
- **Pack turns into chunks of target ~1,000 chars (≈250 tokens), hard max 1,800 chars.** A turn longer than the max splits on sentence boundaries.
- **Overlap: repeat the last speaker turn (capped at 200 chars) at the start of the next chunk** — turn-level overlap preserves conversational context better than fixed-char overlap for diarized text.
- Each chunk's text is prefixed with speaker labels (`Speaker 1: …`) so embeddings capture who said what; `speaker` metadata is set when a chunk is single-speaker, else null. `start_ms`/`end_ms` = first/last token of the chunk.
- **Non-diarized text (summaries, documents):** split on paragraph/heading boundaries, same 1,000/1,800-char targets, 150-char overlap. Summaries are usually 1–3 chunks.

### Ingestion pipeline (Queue-based)

Async model: **Cloudflare Queues** (available on the Free plan since Feb 2026). Section 10 provisions the queue, the DLQ (`littlebird-ingest-dlq`, `max_retries: 3`), and the `INGEST_QUEUE` producer binding. **This section owns the single queue dispatcher** for the whole app. Canonical message shape:

```ts
interface IngestMessage {
  userId: string;
  kind: "transcript" | "summary" | "document";
  parentId: string;        // session id for transcript AND summary; document id for document
  sourceRevision: number;  // server-incremented: sessions.transcript_revision (bumped by
                           // saveTranscript) or summaries.revision (bumped by saveSummary);
                           // memory_documents revision for documents
  jobs?: ("index" | "summarize")[];  // default ["index"]
  requestId?: string;      // correlation id for tracing
}
```

**Dispatcher** `worker/src/queue/consumer.ts` — registers the one `queue()` handler in the Worker export and routes per message:
- `kind: "document"` and any message whose `jobs` include `"index"` (or omit `jobs`) → this section's `ingestMemory(env, msg)`.
- `kind: "transcript"` messages whose `jobs` include `"summarize"` → also invoke section 20's exported `handleTranscriptAutoSummary(env, msg)` (imported contract; section 20 owns its internals). Job failures throw so the queue retries; after 3 retries the message lands in `littlebird-ingest-dlq`.

The message carries no text — the consumer re-reads current content **via section 10's persistence layer** (exported read functions keyed by `parentId` + `kind`, e.g. `getTranscriptContent(env, sessionId)` / `getSummaryContent(env, sessionId)`; documents read from `memory_documents`). A stale queued message therefore simply ingests the latest content. The message's `sourceRevision` (authoritative, server-incremented by `saveTranscript`/`saveSummary`) drives the ordering guard.

Consumer job `ingestMemory(env, msg)` in `worker/src/memory/ingest.ts`:
1. **Revision guard:** if existing `memory_chunks` rows for `(parentId, kind)` have `source_revision > msg.sourceRevision`, a newer ingest already completed — ack and skip. This prevents out-of-order completion of concurrent re-ingests from clobbering newer chunks.
2. Load current content via the persistence layer, chunk → compute `content_hash` per chunk.
3. Diff against existing rows for `(parentId, kind)`: unchanged hashes skip re-embedding (idempotent — safe under Queues' at-least-once delivery); changed/new chunks are (re)embedded; rows beyond the new chunk count are deleted from D1 + Vectorize. **Regenerate = re-ingest**, no special path. All written rows carry `msg.sourceRevision`.
4. Embed changed chunks in batches (bge-m3 accepts arrays; batch ≤ 100 texts/call).
5. `upsert` to Vectorize (namespace = userId, deterministic IDs), then set `embedded_at`/`embedding_model`, and persist `chunk_count` onto `memory_documents` for document ingests (exposed via `GET /api/memory/documents/:id`). Rows written before embedding, so a mid-pipeline failure leaves keyword search working and `embedded_at IS NULL` marks recovery work; a failed message is retried by the queue, then dead-letters.

**Trigger points** — all enqueues go through section 10's persistence services, NOT route handlers:
- `saveTranscript` / `saveSummary` (`worker/src/services/persistence.ts`, section 10) bump `sessions.transcript_revision` / `summaries.revision` and expose a single post-save hook; this section registers the enqueue there (`env.INGEST_QUEUE.send({userId, kind, parentId: sessionId, sourceRevision, jobs})`). Internally generated summaries (section 20's `generateSummary`) also flow through `saveSummary`, so they get indexed with no extra wiring.
- `POST /api/memory/documents` → upsert `memory_documents` row (by `(user_id, source, external_id)` when `external_id` given), bump its revision, enqueue a `kind:'document'` message, return `202 {id, status:"queued"}` immediately (ingestion is async — no synchronous chunk_count).

Recovery: `POST /api/memory/reindex` (body `{session_id?}` or empty = sweep). It re-runs ingestion from source content, so it covers both `embedded_at IS NULL` chunks **and** the case where no chunk rows were created at all (e.g. a message exhausted retries into the DLQ) — the source rows in D1, read through the persistence layer, are always the recovery ground truth.

**Deletion propagation:** `deleteMemoryFor({session_id | document_id})` — `SELECT id FROM memory_chunks WHERE …` → `index.deleteByIds(ids)` (batch ≤ 1,000) → `DELETE FROM memory_chunks …` (FTS triggers clean the virtual table). 10-backend-foundation's `DELETE /api/sessions/:id` handler must call this (flag: assumed endpoint name). `DELETE /api/memory/documents/:id` lives in this section.

### Search (hybrid: vector + keyword)

Core logic lives in an exported, typed module function — the service contract for section 20:

```ts
// worker/src/memory/search.ts
export async function searchMemory(
  env: Env, userId: string, request: MemorySearchRequest,
): Promise<MemorySearchResponse>;
```

The HTTP route `POST /api/memory/search` is a thin wrapper (auth + validation + JSON); section 20's Ask-AI imports and calls `searchMemory` directly, no HTTP hop. It runs two queries in parallel and merges:

1. **Vector:** embed query (1 bge-m3 call) → `VECTORIZE.query(vec, { namespace: userId, topK, filter: {kind?, session_id?, created_at: {$gte,$lte}?}, returnMetadata: 'all' })` → hydrate chunk text from D1 by id.
2. **Keyword:** `SELECT … FROM memory_chunks_fts JOIN memory_chunks … WHERE memory_chunks_fts MATCH ?` (query sanitized into quoted FTS5 terms, `user_id` + filters applied, `ORDER BY rank LIMIT top_k`).
3. **Merge via reciprocal-rank fusion (RRF).** Raw scores are not comparable — Vectorize cosine is in [-1, 1] and FTS5 `bm25` rank is unbounded — so merge on rank, not score: `fused = Σ w_i / (60 + rank_i)` with weights `w_vector = 1.0`, `w_keyword = 0.7` (k=60 standard RRF constant). Dedupe by chunk id (a chunk in both lists sums both terms and keeps `source:'vector'`), sort by fused score desc, truncate to `top_k`. Report `score` = raw fused RRF value (ranking only — RRF values max out around 0.028, never render them as percentages) plus **`display_score` in [0, 1], normalized relative to the top result in this response: `display_score = score / max(score)`, so the top result is always 1.0.** Section 50's palette renders `display_score` (e.g. `display_score * 100%`, ≥ 0.9 = high). Keep the raw cosine in `vector_score` when present.
4. **Hydration:** batch-fetch `sessions` rows for all distinct `session_id`s in one `SELECT id, title, created_at FROM sessions WHERE id IN (…)` and attach `session_title` + session `created_at` to each result (citation data for Ask-AI). Document results get `document_title` + `metadata_json`-derived `url` the same way from `memory_documents`.
5. **Session keyword matches** for the palette: `SELECT id, title, created_at FROM sessions WHERE user_id=? AND title LIKE '%'||?||'%' LIMIT 5` (flag: assumes `sessions.title` from 10-backend-foundation).

## API endpoints (this section owns)

```
POST /api/memory/search        auth required  (thin wrapper over searchMemory())
  body: { query: string, top_k?: number = 8,
          filters?: { kind?: ("transcript"|"summary"|"document")[],
                      session_id?: string, date_from?: string, date_to?: string } }
  200: { results: [{ id, score, display_score, vector_score?, source: "vector"|"keyword",
                     text, kind, session_id?, session_title?, document_id?, document_title?,
                     url?, speaker?, start_ms?, end_ms?, created_at }],
         sessions: [{ id, title, created_at }] }   // plain keyword session matches
  400 empty query; 401 unauthenticated.
  // score = raw RRF fused value (ranking only, ~0.005–0.028 range — do not render);
  // display_score ∈ [0,1], normalized to the top result of THIS response (top = 1.0) —
  // section 50's palette renders display_score; session_title + created_at present on
  // every transcript/summary result (Ask-AI citations).

POST /api/memory/documents     auth required   (contract shared with 40-integrations)
  body: MemoryDocumentInput = { title: string, source: string, text: string,
                                external_id?: string, metadata?: object }
  // metadata is stored as metadata_json; put page URL there: metadata: { url: "…" }
  202: { id, status: "queued" }
  // ingestion is async (queue) — no synchronous chunk_count; re-POST with same
  // (source, external_id) updates the existing document and re-ingests
  // (idempotent via UNIQUE(user_id, source, external_id))

GET /api/memory/documents/:id  → 200 { id, title, source, external_id?, metadata?,
                                       chunk_count, created_at, updated_at }
  // chunk_count persisted by the queue consumer after ingest; 0 while still queued.

DELETE /api/memory/documents/:id  → 204; removes chunks + vectors.

POST /api/memory/reindex       auth required
  body: { session_id?: string }   // omitted = sweep; re-runs ingestion from source
  200: { reindexed: number }      // covers embedded_at IS NULL AND zero-chunk cases
```

Exported module contracts (not HTTP):
- `searchMemory(env, userId, request)` from `worker/src/memory/search.ts` — called by section 20's Ask-AI.
- `ingestMemory(env, msg)` and `deleteMemoryFor(env, {session_id | document_id})` from `worker/src/memory/ingest.ts` — deletion called by 10-backend-foundation's session-delete handler; ingestion enqueued via the `saveTranscript`/`saveSummary` post-save hook.
- The single queue dispatcher in `worker/src/queue/consumer.ts` (this section) is the app's only `queue()` handler; it consumes the canonical `IngestMessage` and calls section 20's `handleTranscriptAutoSummary(env, msg)` for transcript messages with `jobs:["summarize"]`.

## File structure (worker paths assume 10-backend-foundation's `worker/` root — align during integration)

```
worker/src/memory/
  provider.ts        # EmbeddingProvider interface + WorkersAiEmbeddingProvider (bge-m3)
  index-store.ts     # MemoryIndex wrapper over env.VECTORIZE (upsert/query/deleteByIds)
  chunking.ts        # chunkTranscript, chunkText (pure, unit-testable)
  ingest.ts          # ingestMemory (queue job), deleteMemoryFor, reindex sweep
  search.ts          # exported searchMemory(env, userId, request); hybrid RRF merge
  routes.ts          # /api/memory/* route handlers (thin wrappers)
worker/src/queue/consumer.ts        # THE single queue dispatcher (routes IngestMessage
                                    # to ingestMemory and to section 20's
                                    # handleTranscriptAutoSummary for jobs:["summarize"])
worker/migrations/000X_memory.sql   # memory_chunks, memory_documents, fts5 + triggers
worker/wrangler.jsonc               # vectorize binding VECTORIZE, ai binding AI,
                                    # INGEST_QUEUE consumer config (queue + DLQ
                                    # littlebird-ingest-dlq, max_retries 3, provisioned
                                    # by section 10)
src/lib/memory-api.ts               # typed client for /api/memory/search
src/hooks/useMemorySearch.ts        # debounced hook (palette data layer)
src/types.ts                        # + MemorySearchResult, MemorySearchFilters
```

## Implementation tasks

**T1 [parallel — after 10-backend-foundation's worker skeleton exists]: Storage provisioning.**
Migration `worker/migrations/000X_memory.sql` (tables incl. `memory_documents.external_id`/`metadata_json` + `UNIQUE(user_id, source, external_id)` partial index, `memory_chunks.source_revision`, FTS5 + sync triggers). Wrangler setup: `npx wrangler vectorize create littlebird-memory --dimensions=1024 --metric=cosine`, then `vectorize create-metadata-index` for `kind` (string), `session_id` (string), `created_at` (number) — before any insert. Add `VECTORIZE` + `AI` bindings and the `INGEST_QUEUE` consumer config to `worker/wrangler.jsonc` (queue + producer binding provisioned by section 10). Document the FTS5-blocks-`d1 export` caveat in the migration file header.
*Tests:* `wrangler d1 migrations apply --local` succeeds; insert a row and confirm `SELECT … FROM memory_chunks_fts MATCH 'term'` returns it; trigger sync verified on update/delete; duplicate `(user_id, source, external_id)` insert rejected.

**T2 [after T1]: Chunker + embedding seam.**
`worker/src/memory/chunking.ts` (speaker-turn packing, 1,000/1,800-char targets, turn overlap, sentence-split for long turns, paragraph mode for summaries/documents), `provider.ts` (interface + Workers AI impl, batch ≤100), `index-store.ts` (Vectorize wrapper with namespace + deterministic IDs).
*Tests:* vitest unit tests on chunking with fixture diarized token arrays (en + hi/te sample text): chunk sizes within bounds, overlap present, speaker prefixes correct, deterministic output; provider mocked via the interface.

**T3 [after T2]: Queue dispatcher + ingestion + deletion + documents API.**
`worker/src/queue/consumer.ts` — THE single queue handler for the app: parses `IngestMessage {userId, kind, parentId, sourceRevision, jobs?, requestId?}`, routes `kind:"document"` and index jobs to `ingestMemory`, and invokes section 20's exported `handleTranscriptAutoSummary(env, msg)` for transcript messages whose `jobs` include `"summarize"`; throws to trigger queue retry (DLQ `littlebird-ingest-dlq` after 3 retries, provisioned by section 10). `ingest.ts` (`ingestMemory`: `sourceRevision` guard first, then re-read content via section 10's persistence-layer read functions keyed by `parentId`+`kind`, hash-diff idempotent ingest, rows-before-embed ordering, persist `chunk_count` for documents; `deleteMemoryFor`), `POST /api/memory/documents` (upsert by `(user_id, source, external_id)`, store `metadata_json`, bump `revision`, enqueue, return `202 {id, status:"queued"}`), `GET /api/memory/documents/:id` (includes `chunk_count`), `DELETE /api/memory/documents/:id`, `POST /api/memory/reindex` (re-runs ingestion from source content; covers un-embedded chunks and the zero-chunk-rows case). Register the enqueue in section 10's `saveTranscript`/`saveSummary` post-save hook (`worker/src/services/persistence.ts`) — not in route handlers; those services supply `sourceRevision` from `sessions.transcript_revision` / `summaries.revision`. `deleteMemoryFor` wired into the session-delete handler (coordinate with section 10).
*Tests:* `@cloudflare/vitest-pool-workers` integration tests with a mock EmbeddingProvider: dispatcher routes document/index messages to `ingestMemory` and transcript+`jobs:["summarize"]` messages to a mocked `handleTranscriptAutoSummary`; message processed → rows + vectors exist; redelivered identical message → no re-embed (hash skip, at-least-once safe); changed text at higher `sourceRevision` → chunks replaced, stale IDs deleted; stale message (`sourceRevision` lower than stored) → skipped, newer chunks untouched; failing job throws → message retried, and after `max_retries` (3) it dead-letters to `littlebird-ingest-dlq` (simulate via queue test harness / mock retry count); summary and transcript chunks for the same session id coexist (distinct vector-ID `kind` segment) and re-ingest of one kind never touches the other; delete session → zero rows for BOTH kinds and `deleteByIds` called with the right IDs; document re-POST with same `(source, external_id)` updates in place (no duplicate row) and 202 response carries `status:"queued"`; `GET /api/memory/documents/:id` returns `chunk_count` after consumer run (0 before); reindex recreates chunks for a session with zero chunk rows.

**T4 [after T2, parallel with T3]: Hybrid search service + endpoint.**
`search.ts`: exported `searchMemory(env, userId, request)` — parallel Vectorize query (namespace, filters, returnMetadata) + FTS5 query (sanitized MATCH, filters), RRF merge (k=60, w_vector=1.0, w_keyword=0.7), `display_score` normalization (score / top score, top result = 1.0), dedupe, batch session/document hydration (`session_title` + `created_at` on every session-backed result; `document_title` + `url` from `metadata_json` on document results), session-title keyword matches. `routes.ts`: `POST /api/memory/search` as a thin wrapper (auth + validation: reject empty query, cap `top_k` ≤ 25). Export `searchMemory` + request/response types for section 20's direct import.
*Tests:* integration tests with seeded chunks (mock provider returning fixed vectors): filter combinations respected; user A never sees user B's chunks; keyword-only term (e.g. an ID string) surfaces via FTS in the fused list; a chunk hit by both queries ranks above single-source hits (RRF sum); top result has `display_score === 1.0`, all others in (0, 1], ordering by `display_score` matches ordering by raw `score`; every session-backed result carries `session_title` + `created_at`; direct `searchMemory()` call returns same shape as HTTP route; empty query → 400.

**T5 [after T4]: Frontend data layer.**
`src/lib/memory-api.ts` (fetch wrapper on `/api/memory/search`, reuse auth/header helper from 10-backend-foundation's client — flag: assumed helper), `src/hooks/useMemorySearch.ts`: 250 ms debounce, AbortController cancellation of stale requests, `{ results, sessions, isLoading, error }`, returns empty + `disabled: true` when `useOnlineStatus` (existing `src/hooks/useOnlineStatus.ts`) reports offline. Types added to `src/types.ts`.
*Tests:* vitest + jsdom hook tests (root frontend test infra added by section 10) with mocked fetch: debounce coalesces rapid input, stale responses discarded after abort, offline state short-circuits, error surfaced.

**Final integration check:** `wrangler dev` locally (local Vectorize + Queues simulation; note Workers AI binding calls the real API in dev — needs account creds), record → transcribe → queue consumer runs → confirm chunks searchable via `curl POST /api/memory/search` in en and hi with `session_title` populated; delete the session and confirm zero results.

## Cost / limits notes

- **Vectorize free tier (Workers Free):** 5M stored dims and 30M queried dims per month. At 1024 dims: ~4,880 stored chunks (~80–160 hours of meetings — fine for MVP) and ~29k queries/month. Paid tier: 10M stored/50M queried included, then $0.05/100M stored, $0.01/M queried. Hard limits: 1,536 max dims, 10 KiB metadata/vector, 10 metadata indexes (we use 3), 64-byte indexed values, 1,000 namespaces/index on free.
- **Workers AI:** free daily neuron allocation (10k neurons/day) covers MVP embedding volume; bge-m3 ~$0.012/M input tokens beyond. bge-m3 context 8,192 tokens — our ≤1,800-char chunks are far below it.
- **Consistency:** Vectorize mutations are async; newly upserted vectors may not be queryable for a few seconds.
- **If storage outgrows free tier:** halve cost by moving to a 384/768-dim multilingual model behind the provider seam (requires new index + full reindex — dims are fixed per index), or upgrade to Workers Paid.

## Assumed contracts from sibling sections (verify at integration)

- 10-backend-foundation: worker root `worker/` with `worker/wrangler.jsonc`, `env.DB` (D1), auth middleware exposing `user_id`, tables `sessions` (with `title`, `created_at`, server-incremented `transcript_revision` bumped by `saveTranscript`), `transcripts`, `summaries` (with server-incremented `revision` bumped by `saveSummary`); `saveTranscript`/`saveSummary` services in `worker/src/services/persistence.ts` with a single post-save hook where this section registers its enqueue (services supply `sourceRevision` in the message), plus exported persistence-layer read functions the consumer uses to re-read content by `parentId`+`kind`; the `INGEST_QUEUE` queue + producer binding + DLQ `littlebird-ingest-dlq` (`max_retries: 3`); `DELETE /api/sessions/:id` calls `deleteMemoryFor`; root frontend test infra (vitest + jsdom).
- 20-ai-features imports `searchMemory(env, userId, request)` from `worker/src/memory/search.ts` (results include `session_title` + `created_at` for citations), exports `handleTranscriptAutoSummary(env, msg)` for this section's queue dispatcher to invoke on transcript messages with `jobs:["summarize"]`, and its `generateSummary` persists via `saveSummary` so summaries are auto-indexed.
- 40-integrations-capture calls `POST /api/memory/documents` with the shared `MemoryDocumentInput` `{title, source, text, external_id?, metadata?}` (page URL in `metadata.url`).

## Open questions

None blocking. Defaults chosen with rationale: bge-m3 (only multilingual option that covers hi/te on Workers AI), Vectorize (native, zero infra, behind a swap seam), Cloudflare Queues for ingestion durability (on the Free plan since Feb 2026; at-least-once delivery handled by hash-diff idempotency + `sourceRevision` ordering guard), RRF for hybrid merging (rank-based, sidesteps incomparable cosine vs bm25 scales).
