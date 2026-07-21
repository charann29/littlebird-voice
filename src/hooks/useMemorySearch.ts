/**
 * useMemorySearch — debounced hybrid memory search over POST /api/memory/search.
 *
 * Contract (consumed by the command palette via memorySearchAdapter):
 *   { results, sessions, isLoading, error, disabled }
 *
 * - 250 ms debounce: rapid keystrokes coalesce into one request.
 * - Stale-response safety: an AbortController per request; superseded/unmounted
 *   requests are aborted and their results (and errors) discarded.
 * - Offline (per useOnlineStatus): returns empty results with `disabled: true`
 *   and never issues a request.
 * - Empty/whitespace query: no request; results cleared.
 */
import { useEffect, useRef, useState } from "react";
import { searchMemory } from "../lib/memory-api";
import { useOnlineStatus } from "./useOnlineStatus";
import type {
  MemorySearchFilters,
  MemorySearchResult,
  MemorySessionMatch,
} from "../types";

export const SEARCH_DEBOUNCE_MS = 250;

export interface UseMemorySearchResult {
  results: MemorySearchResult[];
  sessions: MemorySessionMatch[];
  isLoading: boolean;
  /** Message from the last failed search (null when ok/idle). */
  error: string | null;
  /** True when semantic search is unavailable (offline). */
  disabled: boolean;
}

const EMPTY: {
  results: MemorySearchResult[];
  sessions: MemorySessionMatch[];
} = { results: [], sessions: [] };

export function useMemorySearch(
  query: string,
  filters?: MemorySearchFilters,
): UseMemorySearchResult {
  const online = useOnlineStatus();
  const [data, setData] = useState(EMPTY);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const trimmed = query.trim();
  // Serialize filters so callers passing inline object literals don't retrigger
  // the effect every render.
  const filtersKey = filters ? JSON.stringify(filters) : "";

  useEffect(() => {
    // Any input change (or going offline) invalidates the in-flight request.
    abortRef.current?.abort();
    abortRef.current = null;

    if (!online || !trimmed) {
      setData(EMPTY);
      setIsLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setIsLoading(true);
    setError(null);

    const timer = setTimeout(() => {
      const parsedFilters = filtersKey
        ? (JSON.parse(filtersKey) as MemorySearchFilters)
        : undefined;
      searchMemory(
        { query: trimmed, filters: parsedFilters },
        controller.signal,
      )
        .then((res) => {
          if (controller.signal.aborted) return;
          setData({ results: res.results, sessions: res.sessions });
          setIsLoading(false);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          setError(err instanceof Error ? err.message : "Search failed");
          setData(EMPTY);
          setIsLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed, filtersKey, online]);

  return {
    results: data.results,
    sessions: data.sessions,
    isLoading,
    error,
    disabled: !online,
  };
}
