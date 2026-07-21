/**
 * mergeSessions — pure merge rule unifying local IndexedDB recordings and
 * server SessionMeta rows into one list (section 50 §3.1).
 *
 * - Join key: the client UUID (Recording.id === sessions.id).
 * - Ids present locally: the local Recording wins for status, createdAt,
 *   durationMs, error, and blob presence — local is source of truth until
 *   synced. The server row contributes title and source.
 * - Ids only on the server: read-only metadata rows (hasLocalAudio: false).
 * - server === null (offline / no token / fetch failed): local-only list.
 * - Output sorted createdAt desc; day grouping is a separate helper.
 */
import type { Recording } from "../types";
import type { SessionMeta, SessionSource, SessionStatus } from "./api-types";

export interface SessionListItem {
  id: string;
  title: string;
  source: SessionSource;
  status: SessionStatus;
  createdAt: number;
  durationMs: number;
  error: string | null;
  hasLocalAudio: boolean;
  /** True when a server row exists for this id. */
  isServerBacked: boolean;
  /** True when only a server row exists (read-only metadata row). */
  isServerOnly: boolean;
  hasSummary: boolean;
}

/** Fallback title for local rows the server hasn't named yet. */
export function defaultTitle(createdAt: number): string {
  const d = new Date(createdAt);
  const date = d.toLocaleDateString([], { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  return `Voice note — ${date}, ${time}`;
}

export function mergeSessions(
  local: Recording[],
  server: SessionMeta[] | null,
): SessionListItem[] {
  const byId = new Map<string, SessionListItem>();

  const serverById = new Map<string, SessionMeta>();
  for (const s of server ?? []) serverById.set(s.id, s);

  for (const rec of local) {
    const remote = serverById.get(rec.id);
    byId.set(rec.id, {
      id: rec.id,
      // Server contributes title/source; v1 Recording has neither.
      title: remote?.title || defaultTitle(rec.createdAt),
      source: remote?.source ?? "mic",
      // Local wins for status/createdAt/duration/error until synced.
      status: rec.status,
      createdAt: rec.createdAt,
      durationMs: rec.durationMs,
      error: rec.error,
      hasLocalAudio: true,
      isServerBacked: Boolean(remote),
      isServerOnly: false,
      hasSummary: readHasSummary(remote),
    });
  }

  for (const s of serverById.values()) {
    if (byId.has(s.id)) continue;
    byId.set(s.id, {
      id: s.id,
      title: s.title || defaultTitle(s.created_at),
      source: s.source,
      status: s.status,
      createdAt: s.created_at,
      durationMs: s.duration_ms,
      error: s.error,
      hasLocalAudio: false,
      isServerBacked: true,
      isServerOnly: true,
      hasSummary: readHasSummary(s),
    });
  }

  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/** `has_summary` is an assumed optional contract addition from section 10. */
function readHasSummary(meta: SessionMeta | undefined): boolean {
  if (!meta) return false;
  return Boolean((meta as { has_summary?: boolean }).has_summary);
}

export interface DayGroup {
  /** "Today" | "Yesterday" | e.g. "Friday, Jul 17" */
  label: string;
  items: SessionListItem[];
}

/** Group a createdAt-desc sorted list by calendar day (local timezone). */
export function groupByDay(
  items: SessionListItem[],
  now: number = Date.now(),
): DayGroup[] {
  const groups: DayGroup[] = [];
  let currentKey = "";

  const today = new Date(now);
  const yesterday = new Date(now);
  yesterday.setDate(today.getDate() - 1);
  const todayKey = today.toDateString();
  const yesterdayKey = yesterday.toDateString();

  for (const item of items) {
    const d = new Date(item.createdAt);
    const key = d.toDateString();
    if (key !== currentKey) {
      currentKey = key;
      const label =
        key === todayKey
          ? "Today"
          : key === yesterdayKey
            ? "Yesterday"
            : new Intl.DateTimeFormat(undefined, {
                weekday: "long",
                month: "short",
                day: "numeric",
              }).format(d);
      groups.push({ label, items: [] });
    }
    groups[groups.length - 1].items.push(item);
  }
  return groups;
}
