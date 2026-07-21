/**
 * Hybrid memory search (section 30) — the service contract for section 20's
 * Ask-AI (direct import, no HTTP hop) and for POST /api/memory/search.
 *
 * Two queries run in parallel and merge via reciprocal-rank fusion:
 *  - vector: embed the query → MemoryIndex.query (namespace = userId,
 *    metadata filters) → hydrate chunk text from D1 by id;
 *  - keyword: FTS5 MATCH over memory_chunks_fts (sanitized quoted terms,
 *    user + filters applied, ORDER BY rank).
 *
 * RRF: fused = Σ w_i / (60 + rank_i), w_vector = 1.0, w_keyword = 0.7.
 * `score` is the raw fused value (ranking only, ~0.005–0.028 — never render);
 * `display_score` ∈ [0,1] is normalized to THIS response's top result
 * (top = 1.0) — that is what the palette renders.
 */

import type { Env } from "../env";
import { getEmbeddingProvider, type EmbeddingProvider } from "./provider";
import {
  getMemoryIndex,
  type MemoryIndex,
  type VectorFilter,
} from "./index-store";

export type MemoryKind = "transcript" | "summary" | "document";

export interface MemorySearchFilters {
  kind?: MemoryKind[];
  session_id?: string;
  /** ISO date (or datetime) lower bound on the parent's created_at. */
  date_from?: string;
  /** ISO date (or datetime) upper bound on the parent's created_at. */
  date_to?: string;
}

export interface MemorySearchRequest {
  query: string;
  /** Result cap (default 8, max 25). */
  top_k?: number;
  filters?: MemorySearchFilters;
}

export interface MemorySearchResult {
  /** Chunk id (== vector id). */
  id: string;
  /** Raw RRF fused score — ranking only, never render. */
  score: number;
  /** ∈ [0,1], normalized to this response's top result (top = 1.0). */
  display_score: number;
  /** Raw cosine similarity, present when the vector query hit this chunk. */
  vector_score?: number;
  source: "vector" | "keyword";
  text: string;
  kind: MemoryKind;
  session_id?: string;
  session_title?: string;
  document_id?: string;
  document_title?: string;
  /** Document URL from memory_documents.metadata_json ({url}). */
  url?: string;
  speaker?: string | null;
  start_ms?: number | null;
  end_ms?: number | null;
  /** Parent (session/document) created_at, epoch ms. */
  created_at: number;
}

export interface MemorySessionMatch {
  id: string;
  title: string;
  created_at: number;
}

export interface MemorySearchResponse {
  results: MemorySearchResult[];
  /** Plain keyword matches on session titles (palette). */
  sessions: MemorySessionMatch[];
}

/** Optional dependency overrides (tests inject mocks here). */
export interface SearchDeps {
  provider?: EmbeddingProvider;
  index?: MemoryIndex;
}

export const DEFAULT_TOP_K = 8;
export const MAX_TOP_K = 25;
const RRF_K = 60;
const W_VECTOR = 1.0;
const W_KEYWORD = 0.7;
/** Overfetch factor per source before fusing. */
const FETCH_MULTIPLIER = 2;

/** Sanitize a free-text query into quoted FTS5 terms ("a" "b" …). */
export function toFtsQuery(query: string): string {
  const terms = query
    .split(/\s+/)
    .map((t) => t.replace(/"/g, "").trim())
    .filter((t) => t.length > 0);
  return terms.map((t) => `"${t}"`).join(" ");
}

/** Parse an ISO date/datetime to epoch ms (undefined if invalid/absent). */
function parseDate(value?: string): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

interface ChunkHydrationRow {
  id: string;
  kind: MemoryKind;
  session_id: string | null;
  document_id: string | null;
  text: string;
  speaker: string | null;
  start_ms: number | null;
  end_ms: number | null;
  created_at: number;
}

const HYDRATE_COLUMNS =
  "id, kind, session_id, document_id, text, speaker, start_ms, end_ms, created_at";

export async function searchMemory(
  env: Env,
  userId: string,
  request: MemorySearchRequest,
  deps: SearchDeps = {},
): Promise<MemorySearchResponse> {
  const query = request.query?.trim() ?? "";
  if (!query) return { results: [], sessions: [] };

  const topK = Math.min(Math.max(request.top_k ?? DEFAULT_TOP_K, 1), MAX_TOP_K);
  const fetchK = topK * FETCH_MULTIPLIER;
  const filters = request.filters ?? {};
  const dateFromMs = parseDate(filters.date_from);
  const dateToMs = parseDate(filters.date_to);

  const [vectorHits, keywordHits, sessionMatches] = await Promise.all([
    vectorQuery(env, userId, query, fetchK, filters, dateFromMs, dateToMs, deps),
    keywordQuery(env, userId, query, fetchK, filters, dateFromMs, dateToMs),
    sessionTitleMatches(env, userId, query),
  ]);

  // RRF merge (rank-based; raw cosine and bm25 are not comparable).
  interface Fused {
    id: string;
    score: number;
    vectorScore?: number;
    source: "vector" | "keyword";
  }
  const fused = new Map<string, Fused>();
  vectorHits.forEach((hit, rank) => {
    fused.set(hit.id, {
      id: hit.id,
      score: W_VECTOR / (RRF_K + rank + 1),
      vectorScore: hit.score,
      source: "vector",
    });
  });
  keywordHits.forEach((id, rank) => {
    const term = W_KEYWORD / (RRF_K + rank + 1);
    const prev = fused.get(id);
    if (prev) {
      prev.score += term; // in both lists: sum terms, keep source 'vector'
    } else {
      fused.set(id, { id, score: term, source: "keyword" });
    }
  });

  const ranked = [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  if (ranked.length === 0) return { results: [], sessions: sessionMatches };

  // Hydrate chunk rows (scoped to user).
  const ids = ranked.map((r) => r.id);
  const { results: rows } = await env.DB.prepare(
    `SELECT ${HYDRATE_COLUMNS} FROM memory_chunks
     WHERE user_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
  )
    .bind(userId, ...ids)
    .all<ChunkHydrationRow>();
  const rowById = new Map(rows.map((r) => [r.id, r]));

  // Batch session/document hydration.
  const sessionIds = [...new Set(rows.map((r) => r.session_id).filter(Boolean))] as string[];
  const documentIds = [...new Set(rows.map((r) => r.document_id).filter(Boolean))] as string[];

  const [sessionRows, documentRows] = await Promise.all([
    sessionIds.length > 0
      ? env.DB.prepare(
          `SELECT id, title, created_at FROM sessions
           WHERE user_id = ? AND id IN (${sessionIds.map(() => "?").join(",")})`,
        )
          .bind(userId, ...sessionIds)
          .all<{ id: string; title: string; created_at: number }>()
          .then((r) => r.results)
      : Promise.resolve([]),
    documentIds.length > 0
      ? env.DB.prepare(
          `SELECT id, title, metadata_json, created_at FROM memory_documents
           WHERE user_id = ? AND id IN (${documentIds.map(() => "?").join(",")})`,
        )
          .bind(userId, ...documentIds)
          .all<{ id: string; title: string; metadata_json: string | null; created_at: number }>()
          .then((r) => r.results)
      : Promise.resolve([]),
  ]);
  const sessionById = new Map(sessionRows.map((s) => [s.id, s]));
  const documentById = new Map(documentRows.map((d) => [d.id, d]));

  const topScore = ranked[0].score;
  const results: MemorySearchResult[] = [];
  for (const entry of ranked) {
    const row = rowById.get(entry.id);
    if (!row) continue; // vector hit whose D1 row is gone (eventual consistency)
    const session = row.session_id ? sessionById.get(row.session_id) : undefined;
    const document = row.document_id ? documentById.get(row.document_id) : undefined;
    let url: string | undefined;
    if (document?.metadata_json) {
      try {
        const meta = JSON.parse(document.metadata_json) as { url?: string };
        if (typeof meta.url === "string") url = meta.url;
      } catch {
        /* malformed metadata — omit url */
      }
    }
    results.push({
      id: row.id,
      score: entry.score,
      display_score: topScore > 0 ? entry.score / topScore : 0,
      ...(entry.vectorScore !== undefined ? { vector_score: entry.vectorScore } : {}),
      source: entry.source,
      text: row.text,
      kind: row.kind,
      ...(row.session_id ? { session_id: row.session_id } : {}),
      ...(session ? { session_title: session.title } : {}),
      ...(row.document_id ? { document_id: row.document_id } : {}),
      ...(document ? { document_title: document.title } : {}),
      ...(url ? { url } : {}),
      speaker: row.speaker,
      start_ms: row.start_ms,
      end_ms: row.end_ms,
      created_at: session?.created_at ?? document?.created_at ?? row.created_at,
    });
  }

  return { results, sessions: sessionMatches };
}

async function vectorQuery(
  env: Env,
  userId: string,
  query: string,
  topK: number,
  filters: MemorySearchFilters,
  dateFromMs: number | undefined,
  dateToMs: number | undefined,
  deps: SearchDeps,
): Promise<{ id: string; score: number }[]> {
  const provider = deps.provider ?? getEmbeddingProvider(env);
  const index = deps.index ?? getMemoryIndex(env);

  const [vector] = await provider.embed([query]);

  const filter: VectorFilter = {};
  if (filters.kind && filters.kind.length > 0) filter.kind = { $in: filters.kind };
  if (filters.session_id) filter.session_id = { $eq: filters.session_id };
  if (dateFromMs !== undefined || dateToMs !== undefined) {
    filter.created_at = {
      ...(dateFromMs !== undefined ? { $gte: Math.floor(dateFromMs / 1000) } : {}),
      ...(dateToMs !== undefined ? { $lte: Math.ceil(dateToMs / 1000) } : {}),
    };
  }

  const matches = await index.query(userId, vector, {
    topK,
    ...(Object.keys(filter).length > 0 ? { filter } : {}),
  });
  return matches.map((m) => ({ id: m.id, score: m.score }));
}

/** FTS5 keyword query → chunk ids ordered by bm25 rank. */
async function keywordQuery(
  env: Env,
  userId: string,
  query: string,
  topK: number,
  filters: MemorySearchFilters,
  dateFromMs: number | undefined,
  dateToMs: number | undefined,
): Promise<string[]> {
  const ftsQuery = toFtsQuery(query);
  if (!ftsQuery) return [];

  const conditions = ["memory_chunks_fts MATCH ?", "c.user_id = ?"];
  const params: unknown[] = [ftsQuery, userId];
  if (filters.kind && filters.kind.length > 0) {
    conditions.push(`c.kind IN (${filters.kind.map(() => "?").join(",")})`);
    params.push(...filters.kind);
  }
  if (filters.session_id) {
    conditions.push("c.session_id = ?");
    params.push(filters.session_id);
  }
  if (dateFromMs !== undefined) {
    conditions.push("c.created_at >= ?");
    params.push(dateFromMs);
  }
  if (dateToMs !== undefined) {
    conditions.push("c.created_at <= ?");
    params.push(dateToMs);
  }

  const { results } = await env.DB.prepare(
    `SELECT c.id FROM memory_chunks_fts
     JOIN memory_chunks c ON c.rowid = memory_chunks_fts.rowid
     WHERE ${conditions.join(" AND ")}
     ORDER BY memory_chunks_fts.rank LIMIT ?`,
  )
    .bind(...params, topK)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

/** Plain keyword matches on session titles (palette list). */
async function sessionTitleMatches(
  env: Env,
  userId: string,
  query: string,
): Promise<MemorySessionMatch[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, title, created_at FROM sessions
     WHERE user_id = ? AND title LIKE '%' || ? || '%'
     ORDER BY created_at DESC LIMIT 5`,
  )
    .bind(userId, query)
    .all<MemorySessionMatch>();
  return results;
}
