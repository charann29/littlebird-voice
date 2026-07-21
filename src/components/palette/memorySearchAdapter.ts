/**
 * memorySearchAdapter — local-only stand-in for section 30's useMemorySearch.
 *
 * INTEGRATION POINT (section 30-T5): when src/hooks/useMemorySearch lands,
 * re-export it from here (or swap the import in CommandPalette.tsx):
 *   export { useMemorySearch as useMemorySearchAdapter } from "../../hooks/useMemorySearch";
 * The contract is identical: { results, sessions, isLoading, disabled }.
 * Living in its own module keeps the swap a one-line change and lets tests
 * vi.mock() it.
 */
import type { MemoryResultLike } from "./paletteItems";

export interface MemorySearchState {
  results: MemoryResultLike[];
  sessions: { id: string; title: string; created_at: number }[];
  isLoading: boolean;
  /** True when semantic search is unavailable (offline / hook not landed). */
  disabled: boolean;
}

/**
 * Local-only stand-in: semantic search disabled, no network. The palette
 * falls back to substring filtering over local sessions.
 */
export function useMemorySearchAdapter(_query: string): MemorySearchState {
  return { results: [], sessions: [], isLoading: false, disabled: true };
}
