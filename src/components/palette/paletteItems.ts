/**
 * paletteItems — pure builder producing ONE flat ordered item list across
 * palette groups so selection is index math (unit-testable, §3.3).
 *
 * Group order: Ask AI → Memory → Sessions → Actions. Each group appears only
 * when non-empty. Empty query: Actions + the 5 most recent sessions
 * (no Memory group).
 */
import type { SessionListItem } from "../../lib/mergeSessions";

/** Shape of one semantic memory chunk (section 30's search result). */
export interface MemoryResultLike {
  id: string;
  session_id?: string;
  /** Raw fused RRF score (~0.03 ceiling) — NEVER used for the bar. */
  score: number;
  /** Normalized [0,1] relative to the top result — bars key on this. */
  display_score: number;
  text: string;
  speaker?: string | null;
  start_ms?: number | null;
  session_title?: string;
  created_at?: number;
}

export type PaletteItem =
  | { kind: "ask"; id: string; query: string }
  | { kind: "memory"; id: string; result: MemoryResultLike }
  | { kind: "session"; id: string; session: SessionListItem }
  | {
      kind: "action";
      id: string;
      label: string;
      to: string;
      state?: unknown;
    };

export interface PaletteGroup {
  label: string;
  hint?: string;
  items: PaletteItem[];
}

export interface PaletteInput {
  query: string;
  memoryResults: MemoryResultLike[];
  sessionMatches: SessionListItem[];
  /** All sessions (recent-first) — used for the empty-query state. */
  recentSessions: SessionListItem[];
  /** Current route's session (adds the contextual follow-up action). */
  currentSession?: { id: string; title: string } | null;
}

const NAV_ACTIONS: { label: string; to: string }[] = [
  { label: "Start capture", to: "/capture" },
  { label: "Go to Capture", to: "/capture" },
  { label: "Go to Sessions", to: "/sessions" },
  { label: "Go to Integrations", to: "/settings/connections" },
  { label: "Go to Settings", to: "/settings" },
];

export function buildPaletteGroups(input: PaletteInput): PaletteGroup[] {
  const query = input.query.trim();
  const groups: PaletteGroup[] = [];

  if (query) {
    groups.push({
      label: "Ask AI",
      hint: "answers from your meeting memory",
      items: [{ kind: "ask", id: "ask", query }],
    });

    if (input.memoryResults.length > 0) {
      groups.push({
        label: "Memory",
        hint: "semantic matches",
        items: input.memoryResults.map((result) => ({
          kind: "memory" as const,
          id: `memory-${result.id}`,
          result,
        })),
      });
    }

    if (input.sessionMatches.length > 0) {
      groups.push({
        label: "Sessions",
        items: input.sessionMatches.map((session) => ({
          kind: "session" as const,
          id: `session-${session.id}`,
          session,
        })),
      });
    }
  } else if (input.recentSessions.length > 0) {
    groups.push({
      label: "Recent sessions",
      items: input.recentSessions.slice(0, 5).map((session) => ({
        kind: "session" as const,
        id: `session-${session.id}`,
        session,
      })),
    });
  }

  const actionItems: PaletteItem[] = [];
  if (input.currentSession) {
    const label = `Draft follow-up for “${input.currentSession.title}”`;
    if (!query || label.toLowerCase().includes(query.toLowerCase())) {
      actionItems.push({
        kind: "action",
        id: "action-followup",
        label,
        to: `/sessions/${input.currentSession.id}`,
        state: { tab: "followups" },
      });
    }
  }
  for (const action of NAV_ACTIONS) {
    if (
      !query ||
      action.label.toLowerCase().startsWith(query.toLowerCase()) ||
      action.label
        .toLowerCase()
        .replace(/^go to /, "")
        .startsWith(query.toLowerCase())
    ) {
      actionItems.push({
        kind: "action",
        id: `action-${action.label.toLowerCase().replace(/\s+/g, "-")}`,
        label: action.label,
        to: action.to,
      });
    }
  }
  if (actionItems.length > 0) {
    groups.push({ label: "Actions", items: actionItems });
  }

  return groups;
}

/** Flatten groups into the single ordered selection list. */
export function flattenPaletteGroups(groups: PaletteGroup[]): PaletteItem[] {
  return groups.flatMap((g) => g.items);
}

/** Wrap-around index move: dir = +1 / -1; -1 selection allowed for empty. */
export function movePaletteIndex(
  current: number,
  dir: 1 | -1,
  length: number,
): number {
  if (length === 0) return -1;
  if (current < 0) return dir === 1 ? 0 : length - 1;
  return (current + dir + length) % length;
}
