/**
 * Ask AI (section 20 T2).
 *
 * - scope="session": answer strictly from that session's transcript — stuff
 *   it when it fits the budget, otherwise relevance-extract map step (max 4
 *   concurrent) then answer over the extracts.
 * - scope="all": retrieve context via section 30's
 *   `searchMemory(env, userId, request)` (worker/src/memory/search.ts),
 *   called in-process, ALWAYS with `filters: { kind: ["transcript",
 *   "summary"] }` so every hit is session-backed and carries
 *   `session_id`/`session_title`/`created_at` for citations. top_k = 12.
 */

import type { Env } from "../env";
import {
  capBlocksAtBudget,
  chunkSegments,
  estimateTokens,
  MAX_INPUT_TOKENS,
  renderTranscript,
} from "./chunking";
import {
  ASK_SYSTEM,
  askAllUserPrompt,
  askSessionUserPrompt,
  relevanceExtractSystem,
  relevanceExtractUserPrompt,
} from "./prompts";
import { getProvider, type LlmProvider } from "./provider";
import {
  loadOwnedSession,
  loadSegments,
  SessionNotFoundError,
  TranscriptNotReadyError,
} from "./summarize";

export const ASK_TOP_K = 12;

/** Source citation emitted in the final SSE event (scope=all). */
export interface AskSource {
  session_id: string;
  title: string;
  snippet: string;
}

export interface AskStreamResult {
  deltas: ReadableStream<string>;
  /** Present for scope=all only. */
  sources?: AskSource[];
}

/* ---- section 30 contract (thin local mirror of memory/search types) ---- */

/** Request shape of searchMemory (subset this section passes). */
export interface MemorySearchRequest {
  query: string;
  top_k: number;
  filters?: { kind?: string[]; session_id?: string };
}

/**
 * Result hit as consumed here. With the kind filter every hit is
 * session-backed: session_id/session_title/created_at are present.
 */
export interface MemorySearchHit {
  text: string;
  score: number;
  session_id?: string;
  session_title?: string;
  created_at?: number;
  speaker?: string | null;
  start_ms?: number | null;
  end_ms?: number | null;
}

export type SearchMemoryFn = (
  env: Env,
  userId: string,
  request: MemorySearchRequest,
) => Promise<{ results: MemorySearchHit[] }>;

/**
 * INTEGRATION POINT (section 30 — memory search).
 * Resolves `searchMemory` from worker/src/memory/search.ts via a guarded
 * dynamic import (indirected specifier so tsc/bundlers don't hard-require
 * the module) so this section builds/tests before 30-T4 lands. WHEN SECTION
 * 30 LANDS: replace the body with
 *   `const { searchMemory } = await import("../memory/search"); return searchMemory;`
 * (a literal specifier, so the bundler includes the module). If the module
 * is absent, scope=all degrades to a canned "not available" answer.
 */
/** Test seam: lets vitest inject a scripted searchMemory. */
let testSearchMemoryOverride: SearchMemoryFn | null = null;
export function setTestSearchMemory(fn: SearchMemoryFn | null): void {
  testSearchMemoryOverride = fn;
}

export async function resolveSearchMemory(): Promise<SearchMemoryFn | null> {
  if (testSearchMemoryOverride) return testSearchMemoryOverride;
  try {
    const specifier = ["..", "memory", "search"].join("/");
    const mod = (await import(/* @vite-ignore */ specifier)) as {
      searchMemory?: SearchMemoryFn;
    };
    return typeof mod.searchMemory === "function" ? mod.searchMemory : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- scope=session */

/** Long-transcript path: relevance-extract per chunk, max 4 concurrent. */
async function extractRelevant(
  provider: LlmProvider,
  chunks: string[],
  question: string,
): Promise<string[]> {
  const extracts: (string | null)[] = new Array(chunks.length).fill(null);
  let next = 0;
  const workers = Array.from({ length: Math.min(4, chunks.length) }, async () => {
    while (next < chunks.length) {
      const i = next++;
      const out = await provider.complete({
        system: relevanceExtractSystem(),
        user: relevanceExtractUserPrompt(chunks[i], question),
      });
      const trimmed = out.trim();
      extracts[i] = trimmed && trimmed !== "NONE" ? trimmed : null;
    }
  });
  await Promise.all(workers);
  // Keep original position order; cap at budget (drop lowest-position extras
  // = later chunks first is NOT wanted — we keep from the start).
  return capBlocksAtBudget(
    extracts.filter((e): e is string => e !== null),
    MAX_INPUT_TOKENS,
  );
}

export async function askSession(
  env: Env,
  userId: string,
  sessionId: string,
  question: string,
): Promise<AskStreamResult> {
  const session = await loadOwnedSession(env, userId, sessionId);
  if (!session) throw new SessionNotFoundError(sessionId);
  const segments = await loadSegments(env, sessionId);
  if (segments.length === 0) {
    throw new TranscriptNotReadyError("Session has no transcript segments");
  }

  const provider = getProvider(env);
  const transcript = renderTranscript(segments);

  let context = transcript;
  if (estimateTokens(transcript) > MAX_INPUT_TOKENS) {
    const chunks = chunkSegments(segments).map((c) => renderTranscript(c));
    const extracts = await extractRelevant(provider, chunks, question);
    context =
      extracts.length > 0 ? extracts.join("\n") : "(no relevant lines found)";
  }

  const deltas = await provider.stream({
    system: ASK_SYSTEM,
    user: askSessionUserPrompt(context, question),
  });
  return { deltas };
}

/* ----------------------------------------------------------------- scope=all */

function formatDate(epochMs: number | undefined): string {
  if (!epochMs) return "unknown date";
  return new Date(epochMs).toISOString().slice(0, 10);
}

/** "— {session_title} ({date}):\n{text}" passage per hit. */
export function formatHitPassage(hit: MemorySearchHit): string {
  return `— ${hit.session_title ?? "Untitled session"} (${formatDate(hit.created_at)}):\n${hit.text}`;
}

export function hitsToSources(hits: MemorySearchHit[]): AskSource[] {
  const seen = new Set<string>();
  const sources: AskSource[] = [];
  for (const hit of hits) {
    if (!hit.session_id || seen.has(hit.session_id)) continue;
    seen.add(hit.session_id);
    sources.push({
      session_id: hit.session_id,
      title: hit.session_title ?? "Untitled session",
      snippet: hit.text.slice(0, 160),
    });
  }
  return sources;
}

/** Single-string stream for canned answers (zero hits / no memory module). */
function textStream(text: string): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      controller.enqueue(text);
      controller.close();
    },
  });
}

export async function askAll(
  env: Env,
  userId: string,
  question: string,
  searchMemoryOverride?: SearchMemoryFn,
): Promise<AskStreamResult> {
  const searchMemory = searchMemoryOverride ?? (await resolveSearchMemory());
  if (!searchMemory) {
    return {
      deltas: textStream(
        "Memory search is not available yet, so I can't search across sessions. Try asking within a single session.",
      ),
      sources: [],
    };
  }

  const { results } = await searchMemory(env, userId, {
    query: question,
    top_k: ASK_TOP_K,
    // ALWAYS filter to session-backed kinds — document hits would break the
    // citation contract (no session_id/session_title).
    filters: { kind: ["transcript", "summary"] },
  });

  if (results.length === 0) {
    return {
      deltas: textStream(
        "No relevant sessions found — I can't answer that from your transcripts.",
      ),
      sources: [],
    };
  }

  const passages = capBlocksAtBudget(results.map(formatHitPassage));
  const provider = getProvider(env);
  const deltas = await provider.stream({
    system: ASK_SYSTEM,
    user: askAllUserPrompt(passages, question),
  });
  return { deltas, sources: hitsToSources(results) };
}
