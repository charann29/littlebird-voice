/**
 * memorySearchAdapter — palette-facing seam over section 30's useMemorySearch.
 *
 * Re-exports the real hook (src/hooks/useMemorySearch) as
 * `useMemorySearchAdapter`. Living in its own module keeps the palette
 * decoupled and lets tests vi.mock() it. The hook's return type is a
 * structural superset of `MemorySearchState` (it additionally exposes
 * `error`), so consumers of the narrower contract keep working.
 */
import type { MemoryResultLike } from "./paletteItems";

export interface MemorySearchState {
  results: MemoryResultLike[];
  sessions: { id: string; title: string; created_at: number }[];
  isLoading: boolean;
  /** True when semantic search is unavailable (offline). */
  disabled: boolean;
}

export { useMemorySearch as useMemorySearchAdapter } from "../../hooks/useMemorySearch";
