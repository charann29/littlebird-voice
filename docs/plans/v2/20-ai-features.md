# 20 — AI Features (summaries, follow-up drafting, Ask AI)

Section of the littlebird-ai-v2 plan. Scope: all LLM-powered features. Builds on
10-backend-foundation (Cloudflare Worker + D1 + auth) and consumes
30-memory-search's retrieval endpoint. Does not plan capture, backend tables,
embeddings, or send-integrations.

All LLM calls run in the Worker. The browser never holds an LLM key and never
calls a model API directly.

---

## Product / spec summary

### Goals
- Turn a raw transcript into a structured meeting summary the user can scan in
  seconds (littlebird.ai's core value prop).
- Draft a grounded, editable, professional follow-up email/message from a
  session (optionally written first-person from the speaker the user marks as
  themselves).
- Answer questions over one session or over all sessions ("what did Priya
  commit to last week?").

### Users / flows
- Same single-user PWA persona as v1. After a session's transcript reaches
  `status = 'done'` (canonical status enum from 10-backend-foundation;
  `transcript_segments` rows written to D1 by the capture/backend flow), a
  summary is auto-generated via 30's queue dispatcher invoking this section's
  exported handler (see Background work below). The user opens the session-detail
  view and sees the summary panel; can hit "Regenerate"; can open a Follow-up
  tab to draft, edit, and copy a message; can ask questions in an Ask-AI panel
  (single session) or via the global command palette (all sessions).

### Expected behavior (acceptance criteria)
1. **Summary**: for a session with a complete transcript, `POST
   /api/sessions/:id/summarize` produces and stores a structured summary with
   sections: Overview, Action items (with owner/due when inferable), Decisions,
   Key quotes (verbatim), Risks/open questions. Rendered in session detail.
   Regenerate replaces the stored summary. Sessions with empty/absent
   transcripts return 409 with a clear error, not a hallucinated summary.
2. **Follow-up**: `POST /api/sessions/:id/followup` streams a grounded,
   editable, professional draft email/message built from the summary +
   transcript. Soniox speakers are anonymous, so "in your voice" is scoped
   down for MVP: an optional "Which speaker is you?" mapping on the session
   (`self_speaker`, see below) lets the model attribute first-person
   perspective to the user's own utterances; without it the draft is written
   neutrally on the user's behalf. No claim of style learned from past
   emails (there is no email-history ingestion; Gmail in 40-integrations is
   send-only). The draft appears in an editable textarea; user edits then
   copies. Nothing is auto-sent (sending is 40-integrations). Draft is
   ephemeral (not stored server-side).
3. **Ask AI**: `POST /api/ask` with `scope: "session"` answers strictly from
   that session's transcript; `scope: "all"` retrieves context via
   30-memory-search's `searchMemory(env, userId, request)` module function and
   cites which sessions the answer came from. Answers stream token-by-token to
   the UI. "I don't know from these transcripts" is the required behavior when
   context lacks the answer.
4. Summaries/answers match the dominant transcript language (en/hi/te); quotes
   stay verbatim in their original language.
5. Transcripts longer than the model context are handled by map-reduce
   chunking, not truncation, and never fail solely due to length.

### Non-goals
- Sending follow-ups anywhere (40-integrations).
- Building retrieval/embeddings (30-memory-search).
- Multi-turn chat memory in Ask AI (single question → single answer per call;
  the panel keeps a local Q&A history for display only).
- Realtime "summarize while recording".
- Learning the user's writing style from email history or other external
  corpora (no such ingestion exists; follow-up "voice" = first-person
  attribution via the optional speaker mapping only).

### Edge cases to handle
- Session status not `'done'` (still recording/transcribing/error) →
  summarize returns 409 `transcript_not_ready`.
- Model returns malformed JSON → one repair retry, then 502 `ai_bad_output`.
- Workers AI capacity error / 429 → retry with backoff (see error policy),
  then surface 503 `ai_unavailable`; the client shows retry affordance.
- `scope: "all"` with zero search hits → answer "no relevant sessions found",
  not an ungrounded LLM answer.
- Concurrent summarize calls for the same session → `saveSummary` upserts per
  `(session_id, kind)`, last write wins; UI disables the button while in
  flight.
- No `self_speaker` mapping set → follow-up drafts neutrally; UI offers the
  mapping but never requires it.

---

## LLM provider decision

**Default: Cloudflare Workers AI, model `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.**

Why:
- Zero extra keys/accounts: it's a native binding (`env.AI`) on the same
  Worker the backend foundation already deploys. No secret management, no
  egress.
- Good-enough quality for summarization/drafting at 70B; native SSE streaming
  (`stream: true`) and JSON mode (`response_format: { type: "json_schema" }`)
  — both needed here.
- Cost: roughly $0.29/M input + $2.25/M output tokens (verify against current
  Cloudflare pricing at build time); a 1-hour meeting (~13k input tokens) plus
  a ~1k-token summary costs well under $0.01. Free tier (10k neurons/day)
  covers development.

Constraint: 24k-token context window → the map-reduce strategy below is
mandatory for long transcripts. (`@cf/meta/llama-4-scout-17b-16e-instruct` has
131k context but weaker reasoning; not the default, but works through the same
seam if long-context proves more valuable than quality.)

**Provider seam** (so Anthropic/OpenAI can be swapped in later): all model
calls go through one interface in `worker/src/ai/provider.ts`:

```ts
interface LlmProvider {
  complete(req: { system: string; user: string; json?: JsonSchema; maxTokens?: number }): Promise<string>;
  stream(req: { system: string; user: string; maxTokens?: number }): ReadableStream<string>; // decoded text deltas
}
// factory reads env: AI_PROVIDER ("workers-ai" default) + AI_MODEL
```

`WorkersAiProvider` is the only implementation in this plan. Model id lives in
an env var (`AI_MODEL`, default `@cf/meta/llama-3.3-70b-instruct-fp8-fast`),
never hardcoded at call sites.

---

## API endpoints

All under the 10-backend REST base, behind its auth middleware (user_id from
auth; every handler verifies the session belongs to the user). Error body
shape (canonical, from section 10): `{ error: { code: string, message: string } }`.

### `POST /api/sessions/:id/summarize`
- Generates (or regenerates) the summary. No body.
- 200 → `{ summary: SummaryV1 }`. Persistence goes through section 10's
  `saveSummary(env, userId, sessionId, kind, payload, model?)`
  (`worker/src/services/persistence.ts`, kind `"meeting_summary"`) — never a
  direct write to `summaries` — so its post-save hook publishes to
  `INGEST_QUEUE` and internally generated summaries get memory-indexed too.
  Payload lands in `summaries.payload_json`. Any future transcript writes from
  this section likewise use `saveTranscript(...)`, never raw SQL.
  Non-streaming (JSON-mode output can't stream usefully).
- 409 `{ error: { code: "transcript_not_ready" } }` if the session status is
  not `'done'` or there are no `transcript_segments` rows.
- Also runs server-side when a transcript completes: section 30's queue
  dispatcher invokes this section's exported
  `handleTranscriptAutoSummary(env, msg)` handler (see Background work).

### Self-speaker mapping (consumed from section 10)
Section 10 owns the nullable `sessions.self_speaker` column (canonical DDL)
and its `PATCH /api/sessions/:id` route — this section adds NO route for it.
This section only consumes: the follow-up prompt builder reads
`self_speaker` from the session row, and T3's speaker picker calls 10's
PATCH endpoint via `src/lib/api.ts`.

### `GET /api/sessions/:id/summary`
- Reads the stored summary row. 200 `{ summary: SummaryV1, generated_at }` or
  404 `{ error: { code: "no_summary" } }`.

### `POST /api/sessions/:id/followup`
- Body: `{ format: "email" | "message", instructions?: string }`
  (`instructions` = optional user steer, e.g. "keep it short, mention the
  deadline").
- Response: SSE stream (`text/event-stream`): `data: {"delta":"..."}` events,
  final `data: {"done":true}`. Nothing persisted.

### `POST /api/ask`
- Body: `{ question: string, scope: "session" | "all", session_id?: string }`
  (`session_id` required when scope=session).
- Response: SSE stream: `data: {"delta":"..."}` events, then a final
  `data: {"done":true, "sources":[{"session_id","title","snippet"}]}` event
  (sources only for scope=all).
- scope=all context comes from 30-memory-search's typed module function
  `searchMemory(env, userId, request)` (exported from
  `worker/src/memory/search.ts`), called in-process (same Worker) — NOT an
  HTTP self-call to `/api/memory/search`. Consumed contract (this section
  requires it): request `{ query: string, top_k: number, filters?: ... }`.
  Ask ALWAYS passes `filters: { kind: ["transcript", "summary"] }` — search
  results can otherwise be document-backed (`document_id`/`document_title`,
  no session fields), which would break the citation contract; with this
  filter every hit is session-backed and includes `session_id`,
  `session_title`, session `created_at`, `text`, `speaker?`, `start_ms?`,
  `end_ms?`, `score`. `session_title` and `created_at` are required for the
  citation lines and the `sources` SSE event. We pass `top_k: 12`.

### `SummaryV1` payload (stored in `summaries.payload_json` via `saveSummary`)

```ts
interface SummaryV1 {
  version: 1;
  model: string;               // model id used
  source_revision: number;     // sessions.transcript_revision this was built from (idempotency)
  request_id: string | null;   // requestId of a forced regeneration, else null (idempotency)
  overview: string;            // 2-4 sentences
  action_items: { text: string; owner: string | null; due: string | null }[];
  decisions: string[];
  key_quotes: { speaker: string | null; quote: string }[];
  risks_open_questions: string[];
}
```

---

## Prompt templates

Kept in `worker/src/ai/prompts.ts` as template functions. Transcripts are
rendered as `[{speaker}] ({mm:ss}) {text}` lines from the `transcript_segments`
rows.

**Summarize (system):**
> You summarize meeting/voice-note transcripts. Output only valid JSON matching
> the given schema. Overview: 2–4 sentences. Action items: concrete tasks;
> set owner/due only if stated or clearly inferable, else null. Decisions:
> things agreed or concluded. Key quotes: short verbatim quotes (keep original
> language). Risks/open questions: unresolved issues. Write in the transcript's
> dominant language. If a section has nothing, use an empty array. Never invent
> content not in the transcript.

**Summarize (user):** `Session title: {title}\nDuration: {mm:ss}\nTranscript:\n{transcript}`
— with `response_format: { type: "json_schema", json_schema: SUMMARY_SCHEMA }`.

**Summarize reduce step (long transcripts):** same system prompt, user message
is `Partial summaries of consecutive segments of one meeting:\n{JSON partials}\nMerge into one summary. Deduplicate action items/decisions; keep the best quotes.`

**Follow-up (system):**
> You draft a clear, professional follow-up {format} on behalf of the user who
> recorded this session. Write in first person. {self_speaker set ? "The user
> is speaker {self_speaker}; treat that speaker's statements and commitments
> as the user's own." : "It is unknown which speaker is the user; write
> neutrally on their behalf and do not guess."} Ground every claim in the
> summary/transcript; do not invent commitments. Structure: brief
> thanks/context, key outcomes, action items with owners, next step. Output
> only the draft ({format === "email" ? "include a Subject: line" : "no
> subject line"}). No preamble.

**Follow-up (user):** `Summary:\n{SummaryV1 as JSON}\n\nTranscript excerpts:\n{first + last ~1500 tokens of transcript}\n\nUser instructions: {instructions | "none"}`

**Ask (system):**
> Answer the question using ONLY the provided transcript context. Quote or
> paraphrase with attribution (speaker, and session title when multiple
> sessions are given). If the context does not contain the answer, say you
> can't find it in the transcripts. Be concise.

**Ask (user, scope=session):** `Transcript:\n{transcript (budgeted)}\n\nQuestion: {question}`
**Ask (user, scope=all):** `Context passages from the user's sessions:\n{for each hit: "— {session_title} ({date}):\n{text}"}\n\nQuestion: {question}`

**Relevance-extract map step (long single-session ask only):**
> From this transcript segment, copy the lines relevant to the question,
> verbatim with speaker labels. If nothing is relevant, output NONE.

---

## Token budget / long-transcript strategy

In `worker/src/ai/chunking.ts`. Token estimate: `ceil(chars / 4)` (no
tokenizer dependency; conservative for hi/te scripts — treat estimate as a
floor and keep 20% headroom).

Budget for the default model (24k context): reserve 2k for system+question and
2k for output → **max ~18k estimated input tokens per call**.

- **Summarize:** if the rendered transcript fits the budget → single call.
  Else split into chunks of ~10k tokens on speaker-turn boundaries (never
  mid-utterance), map: summarize each chunk to a partial `SummaryV1` (JSON
  mode), reduce: merge partials with the reduce prompt (one level of reduce is
  enough: 18k budget ÷ ~1k per partial ≫ realistic chunk counts).
- **Ask, scope=session:** if transcript fits → stuff it. Else map: run the
  relevance-extract prompt per chunk (parallel, max 4 concurrent), concatenate
  non-NONE extracts (cap at budget, drop lowest-position extras), then answer
  over the extracts.
- **Ask, scope=all:** `searchMemory` with `top_k: 12`; hits are short
  passages — always fits; truncate the hit list at budget as a guard.
- **Follow-up:** summary JSON + first/last ~1500 transcript tokens — always
  fits by construction.

## Error / retry policy

In `worker/src/ai/provider.ts` (shared wrapper). All HTTP error responses use
the canonical body `{ error: { code, message } }`:
- Transient model errors (429, 5xx, capacity, network) → retry twice with
  1s/3s backoff. Then map to HTTP 503 `{ error: { code: "ai_unavailable" } }`.
- JSON-mode output that fails schema/`JSON.parse` validation → one repair
  retry appending "Your previous output was invalid JSON. Output only valid
  JSON for the schema." Then 502 `{ error: { code: "ai_bad_output" } }`.
- Streaming endpoints: retries only apply before the first delta is sent;
  after that, on error emit `data: {"error":{"code":"...","message":"..."}}`
  and close.
- Queue path (`handleTranscriptAutoSummary`): throwing lets 30's dispatcher /
  the queue retry with its backoff (`max_retries` from 10's queue config);
  terminal `ai_bad_output` after the repair retry is logged and dropped — the
  user can still summarize manually. Retries are safe: the revision/requestId
  guards make the handler idempotent.
- Client: hooks surface `{ status: "error", code }`; UI shows a Retry button
  (no auto-retry loops in the browser).

## Background work (auto-summary on transcript completion)

Chosen approach: **queue-driven** via section 10's `INGEST_QUEUE` (Cloudflare
Queues — available on the Free plan since Feb 2026, so no plan upgrade
needed). Long map-reduce summaries must NOT run in `ctx.waitUntil` (the ~30s
post-response limit is too tight for multi-chunk map-reduce); the queue
consumer has full CPU/wall-clock allowances and built-in retries.

Ownership: section 30-T3 owns the single queue dispatcher
(`worker/src/queue/consumer.ts`). This section does NOT modify or register
the consumer; it only exports a pure handler the dispatcher invokes.

Flow:
- When the capture/backend flow saves the final transcript (via 10's
  `saveTranscript(...)`, which server-increments `sessions.transcript_revision`),
  10's post-save hook enqueues an `IngestMessage`
  `{ userId, kind: "transcript", parentId: sessionId, sourceRevision, jobs?,
  requestId? }` on `INGEST_QUEUE`.
- This section exports `handleTranscriptAutoSummary(env, msg: IngestMessage)`
  from `worker/src/ai/summarize.ts`; 30's dispatcher calls it for
  `kind: "transcript"` messages whose `jobs` include `"summarize"` (alongside
  its own embedding ingestion).
- **Idempotency (at-least-once delivery):** the generated payload records the
  transcript revision it was built from (`SummaryV1.source_revision =
  msg.sourceRevision`). `handleTranscriptAutoSummary` first loads the existing
  `meeting_summary`; if its `source_revision` already equals
  `msg.sourceRevision` and the message is not a forced regeneration, it
  returns without calling the model — redelivered messages are no-ops. It also
  skips (drops) stale messages where `msg.sourceRevision` no longer matches
  the session's current `transcript_revision`.
- **Manual regeneration** enqueues a distinct message shape:
  `{ ..., jobs: ["summarize"], forceSummary: true, requestId }` — `forceSummary`
  bypasses the revision short-circuit; `requestId` is the idempotency key so a
  redelivered forced message doesn't regenerate twice (compare against the
  `request_id` recorded in the stored payload).
- `generateSummary` persists via `saveSummary(env, userId, sessionId,
  "meeting_summary", payload)`, whose own post-save hook enqueues the summary
  for memory ingestion — summaries become searchable without extra wiring.
- The manual `POST /api/sessions/:id/summarize` route calls `generateSummary`
  synchronously in the request (acceptable: a single-call summary is seconds);
  when the estimated chunk count > 3 it instead responds 202
  `{ status: "queued" }` and enqueues the forced message above, and the UI
  polls `GET .../summary`.

## Cost notes

At ~$0.29/M in + ~$2.25/M out: summary of a 1h meeting ≈ $0.006; follow-up ≈
$0.003; ask(all) ≈ $0.002. Even heavy daily use is cents/month; no budget
guard needed beyond the existing auth. Map-reduce roughly doubles input tokens
for long sessions — still negligible. Verify current Workers AI pricing when
building.

---

## Implementation tasks

Layout from 10-backend-foundation: Worker code at `worker/` with
`worker/src/index.ts` (router), `worker/wrangler.jsonc`, an `Env` type with
`DB: D1Database` and `INGEST_QUEUE: Queue`, auth middleware providing
`user_id`, persistence services `saveTranscript`/`saveSummary` in
`worker/src/services/persistence.ts`, root vitest+jsdom test infra, and a
frontend fetch helper `src/lib/api.ts` that attaches auth. This section adds
`AI: Ai` to `Env` and an `"ai": { "binding": "AI" }` entry plus an `AI_MODEL`
var to `worker/wrangler.jsonc`.

### T1 — Worker AI core + summaries slice `[after 10-backend-foundation]`
Create:
- `worker/src/ai/provider.ts` — `LlmProvider` interface, `WorkersAiProvider`
  (env.AI, `AI_MODEL` env, retry/backoff + JSON-repair wrapper), factory.
- `worker/src/ai/prompts.ts` — all templates above + `SUMMARY_SCHEMA`
  (JSON schema for `SummaryV1`).
- `worker/src/ai/chunking.ts` — token estimator, speaker-boundary chunker,
  budget constants.
- `worker/src/ai/summarize.ts` — `generateSummary(env, userId, sessionId,
  opts?: { sourceRevision?, requestId? })`: verify status `'done'`, load
  `transcript_segments` rows, render, single-call or map-reduce, validate,
  persist via `saveSummary(env, userId, sessionId, "meeting_summary",
  payload)` (never a direct `summaries` write); AND the exported pure handler
  `handleTranscriptAutoSummary(env, msg: IngestMessage)` with the
  idempotency/staleness guards from Background work (revision short-circuit,
  `forceSummary`/`requestId` handling). This section does NOT create, modify,
  or register the queue consumer — 30-T3's dispatcher
  (`worker/src/queue/consumer.ts`) imports and invokes the handler.
- `worker/src/routes/ai.ts` — `POST /api/sessions/:id/summarize` (incl. the
  202-and-enqueue path for long transcripts), `GET /api/sessions/:id/summary`;
  register in `worker/src/index.ts`. (No `PATCH /api/sessions/:id` here —
  section 10 owns it.)
- `shared/types/summary.ts` (or wherever 10 puts shared types) — `SummaryV1`.
Modify: `worker/wrangler.jsonc` (AI binding, `AI_MODEL` var), `Env` type.
Tests (root vitest infra from section 10): unit tests for chunker
(boundary handling, budget math), token estimator, `SummaryV1` validation,
reduce-merge with fixture partials; `handleTranscriptAutoSummary` with a
mocked env — redelivered message with matching `source_revision` is a no-op,
stale `sourceRevision` is dropped, `forceSummary` bypasses the
short-circuit, duplicate forced `requestId` is a no-op; integration:
`wrangler dev` + curl summarize/summary happy path, 409 on non-`done`
session, malformed-JSON repair path with a mocked provider, and
`saveSummary` invoked (spy) rather than direct DB writes.

### T2 — Follow-up + Ask endpoints with streaming `[after T1]`
Create:
- `worker/src/ai/stream.ts` — helper turning `LlmProvider.stream()` into an
  SSE `Response` (`data: {"delta"}` / `{"done"}` / `{"error"}` framing).
- `worker/src/ai/followup.ts` — build follow-up prompt from stored summary
  (generate first if missing) + transcript head/tail excerpts + the session's
  `self_speaker` mapping (neutral variant when null).
- `worker/src/ai/ask.ts` — scope=session (stuff or relevance-extract
  map-reduce) and scope=all (call 30's `searchMemory(env, userId, request)`
  in-process with `filters: { kind: ["transcript", "summary"] }` so every hit
  is session-backed, build cited context using `session_title` + `created_at`
  from its results, emit `sources` in the final SSE event).
Modify: `worker/src/routes/ai.ts` — `POST /api/sessions/:id/followup`,
`POST /api/ask`.
Tests (root vitest infra): unit tests for prompt builders (excerpt
budgeting, self_speaker set/null variants, sources formatting, zero-hit
path, kind filter always passed to `searchMemory`) with mocked
provider/`searchMemory`; integration: curl `-N` both
endpoints, verify SSE framing, mid-stream error event, scope=all citations,
400 on missing `session_id` when scope=session.

### T3 — Frontend hooks + panels `[after T2]` (summary-only parts can start after T1)
Create:
- `src/lib/sse.ts` — POST + `ReadableStream` reader parsing the SSE framing
  into `{onDelta, onDone, onError}` callbacks (fetch-based, works with auth
  headers; native `EventSource` can't POST).
- `src/hooks/useSummary.ts` — `{ summary, status, generate }`; fetch stored
  summary on mount, `generate()` calls summarize; states
  idle/loading/generating/ready/error(code).
- `src/hooks/useFollowup.ts` — `{ draft, status, generate(format,
  instructions), setDraft }`; streams deltas into `draft`; user edits are
  local state; Copy button copies current text.
- `src/hooks/useAskAi.ts` — `{ entries, ask(question, scope, sessionId?),
  streaming }`; local Q&A history with per-entry streamed answer + sources.
  This is the data hook the separately-designed command palette calls —
  export its types from here.
- `src/components/session/SummaryPanel.tsx` — renders the five SummaryV1
  sections (action items as checklist rows with owner/due chips), Regenerate
  button, empty/error/generating states.
- `src/components/session/FollowUpDraft.tsx` — format toggle
  (email/message), optional instructions input, a "Which speaker is you?"
  picker (lists the session's diarized speaker labels, sets `self_speaker`
  via section 10's `PATCH /api/sessions/:id`, optional), streamed draft in
  an editable textarea, Copy button. Copy is the terminal action; explicitly
  no Send.
- `src/components/session/AskAiPanel.tsx` — question input, streamed answer
  list, source chips linking to sessions (scope=all).
Modify: the session-detail view (owned by the capture/sessions UI section —
reconcile mount point; these components take `sessionId` and are otherwise
self-contained), `src/lib/api.ts` for the new endpoints.
Tests: vitest for `sse.ts` parser (split-chunk deltas, error event) and hook
state machines with mocked fetch; `npm run typecheck`; manual: full flow
against `wrangler dev` — record → session status `done` → summary appears →
regenerate → follow-up stream + edit + copy → ask in both scopes offline/online
(AI features require connectivity; panels show an offline-disabled state via
`useOnlineStatus`).

### Final integration check `[after T3]`
One scripted pass: seed a `sessions` row (status `done`) +
`transcript_segments` rows into D1 (`wrangler d1 execute`), hit all five
endpoints via curl (summarize, summary, followup, ask, plus 10's
self_speaker PATCH), verify the queue-driven auto-summary by pushing a
`kind: "transcript"` message (jobs including `"summarize"`) through the
local queue and confirming a redelivery is a no-op, load the UI and verify
the three panels end-to-end, including a >24k-token synthetic transcript
exercising map-reduce (202 `queued` path).

---

## Contracts consumed / to reconcile (for the main agent, not user questions)
Resolved against sibling sections (aligned in this revision):
- Section 10: status enum `'pending'|'transcribing'|'done'|'error'` (`'done'` =
  transcript complete); tables `transcript_segments` + `summaries.payload_json`
  (upsert per `(session_id, kind)`, ownership via `session_id →
  sessions.user_id` join — `saveSummary` enforces it); persistence services
  `saveTranscript`/`saveSummary` in `worker/src/services/persistence.ts` with
  the post-save `INGEST_QUEUE` hook and the server-incremented
  `sessions.transcript_revision`; `IngestMessage = { userId, kind, parentId,
  sourceRevision, jobs?, requestId? }`; the nullable `sessions.self_speaker`
  column + its `PATCH /api/sessions/:id` route (owned by 10, consumed here);
  `worker/wrangler.jsonc`; error bodies `{ error: { code, message } }`; root
  vitest+jsdom test infra.
- Section 30: `searchMemory(env, userId, request)` from
  `worker/src/memory/search.ts` (results carrying `session_title` +
  `created_at` for citations; Ask passes `filters: { kind: ["transcript",
  "summary"] }`), and the single queue dispatcher
  `worker/src/queue/consumer.ts` (30-T3) that invokes this section's exported
  `handleTranscriptAutoSummary(env, msg)` for `kind: "transcript"` messages
  with jobs including `"summarize"`.
Still to reconcile:
- `summaries.kind` value: this section uses `"meeting_summary"` (listed in
  10's kind examples).
- Session-detail view + command-palette mount points — from the capture/UI
  and design workstreams.

## Open questions for the user
None blocking. Provider default (Workers AI, llama-3.3-70b-instruct-fp8-fast)
is a recommendation with an explicit swap seam; follow-up drafts are
deliberately ephemeral; summaries auto-generate on transcript completion with
manual regenerate. If the main agent wants user sign-off on the provider
(Workers AI convenience vs. Anthropic/OpenAI quality at the cost of an API
key), ask; otherwise proceed.
