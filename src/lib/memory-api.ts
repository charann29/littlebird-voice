/**
 * memory-api — typed client for the section-30 memory endpoints.
 *
 * Thin wrapper over `apiFetch` (bearer token + `/api` prefix + ApiError
 * normalization). Accepts an AbortSignal so callers (useMemorySearch) can
 * cancel stale in-flight searches while the user is still typing.
 */
import { apiFetch } from "./api";
import type {
  MemorySearchFilters,
  MemorySearchResponse,
} from "../types";

export interface MemorySearchParams {
  query: string;
  /** Result cap (server default 8, max 25). */
  top_k?: number;
  filters?: MemorySearchFilters;
}

/** POST /api/memory/search — hybrid (vector + keyword) memory search. */
export function searchMemory(
  params: MemorySearchParams,
  signal?: AbortSignal,
): Promise<MemorySearchResponse> {
  return apiFetch<MemorySearchResponse>("/memory/search", {
    method: "POST",
    body: JSON.stringify(params),
    signal,
  });
}
