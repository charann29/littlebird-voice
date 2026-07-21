# littlebird-voice v2 — littlebird.ai-style AI meeting assistant (Summary)

Evolves the shipped v1 offline-first voice-transcription PWA into an AI meeting
assistant while keeping the offline-first recording differentiator intact.

## What gets built (5 sections)

**1. Backend foundation (Cloudflare Worker + D1).** One Hono Worker serves both
the built PWA and `/api/*` (same origin, no CORS). D1 tables: `users`,
`sessions`, `transcript_segments`, `summaries` — all `user_id`-scoped from day
one (single-user MVP, multi-user is a migration not a rewrite). Shared bearer
token auth. The Soniox key moves fully server-side: realtime uses Soniox
temporary API keys minted by `POST /api/auth/soniox-token`; async transcription
goes through an allow-listed `/api/stt/*` relay. Frontend keeps IndexedDB as
the local source of truth (audio blobs stay local-only); text/metadata push-sync
up when online via client-UUID idempotent upserts.

**2. AI features (Workers AI).** Default model
`@cf/meta/llama-3.3-70b-instruct-fp8-fast` behind a swappable `LlmProvider`
seam. Structured session summaries (Overview, Action items w/ owner+due,
Decisions, Key quotes, Risks) auto-generated on transcript completion (via a
durable Cloudflare Queue, not fire-and-forget) + manual regenerate; grounded,
editable follow-up email drafting with an optional "which speaker is you?"
mapping for first-person perspective (SSE streaming); Ask AI over one session
or all sessions (cross-session retrieval via memory search). Map-reduce
chunking for long transcripts, JSON-repair + retry policy.

**3. Memory & semantic search (Vectorize + bge-m3).** Multilingual embeddings
(`@cf/baai/bge-m3`, 1024-dim — covers en/hi/te transcripts) into Cloudflare
Vectorize, namespaced per user. Speaker-turn chunking with content-hash
idempotent re-index; D1 `memory_chunks` as canonical text store + FTS5 keyword
fallback merged with vector results. `POST /api/memory/search` powers Ask-AI
and the ⌘K command palette; `POST /api/memory/documents` ingests external docs;
session delete propagates to vectors.

**4. Capture upgrades + integrations.** (A) Meeting capture: WebAudio mixer
composes mic + `getDisplayMedia` tab/screen audio into one stream feeding both
live transcription and the offline recording queue; Meeting-mode UI with
"Mic only / Tab + Mic / Screen + Mic" picker (native limits documented: per-
session share prompt required, browser picker is authoritative,
desktop-Chromium-only tab audio). (B) Worker-side integrations framework:
Connector registry, OAuth with signed single-use state, AES-GCM token
encryption at rest; first connectors Google Calendar, Gmail, Slack, Notion
with minimal scopes; Connections settings UI.

**5. Frontend shell & navigation.** react-router v7 + persistent-sidebar shell
per the approved mockups. MVP sidebar is honest: Capture, Sessions, Ask AI,
Integrations, Settings & Privacy (Prep/Routines/Summaries/Memory/Follow-ups
are omitted, not dead links). Sessions list merges local IndexedDB recordings
with synced server sessions (client UUID join key, local wins until synced);
two-column session detail (diarized transcript + Summary/Follow-ups tabs,
local blob playback); ⌘K command palette (debounced semantic + keyword search,
full keyboard nav); Settings hosts token entry (drains the sync outbox on
save) and the Connections UI. Shell renders fully offline.

## UI (see Design tab)
Sidebar shell + Sessions list, Meeting capture screen, ⌘K command palette with
semantic results, and a two-column session detail (diarized transcript + AI
summary / follow-up draft). All lifted from the existing v1 design tokens.

## Execution order
Section 1 first (scaffold, persistence services, queue, Soniox relay, api
client + test infra) → sections 2, 3, capture track A, and the shell in
parallel (explicit task DAG in the detailed plan) → integrations track B →
a final cross-section integration + browser E2E task.
~20 numbered tasks across the five section files.

## Key decisions already made (with upgrade paths)
- Hono + D1 + same-origin asset serving; shared bearer token auth
  (single-user MVP; multi-user is a documented upgrade path).
- Soniox key fully server-side: temp keys for realtime, allow-listed relay
  for async. No key in the client bundle.
- Workers AI for LLM + embeddings (zero extra API keys; provider seams for
  Anthropic/OpenAI later).
- Durable Cloudflare Queue (Free plan) for ingestion/auto-summary; persisted
  IndexedDB sync outbox for offline-safe upserts AND deletes.
- Audio blobs never uploaded in MVP (R2 kept as a future-design note only).
- Root vitest+jsdom test infra added in section 1; final browser E2E gate.

## Open questions (answer via the decision cards / plan comments)
1. Cloudflare hosting target (use your account / API-only / local-dev only).
2. Integrations MVP: read-only first vs all four with send actions vs drop Gmail.
3. OAuth app ownership + redirect domain (workers.dev vs custom).
4. Calendar: prep-list only vs scheduled auto-created sessions.
5. Mobile nav: sidebar collapses to a slide-over drawer on phones
   (recommended) vs bottom tab bar vs desktop-first.
