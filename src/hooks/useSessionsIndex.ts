/**
 * useSessionsIndex — the merged (local IndexedDB + server) sessions list.
 *
 * Hydrates from useRecordings().recordings (already reactive) instantly and
 * with zero network; overlays GET /api/sessions?limit=100 when online with a
 * token set. Re-fetches on `online` events and window focus. No polling.
 * Server failure degrades silently to the local-only list.
 *
 * The server rows live in a MODULE-LEVEL shared store so every consumer
 * (sessions list, command palette, sidebar counts) sees the same data from a
 * single deduped fetch — mounting the hook in N places never issues N
 * concurrent requests.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRecordings } from "./useRecordings";
import { useOnlineStatus } from "./useOnlineStatus";
import { apiFetch, getApiToken, onApiTokenChange } from "../lib/api";
import type { SessionMeta, SessionsListResponse } from "../lib/api-types";
import {
  groupByDay,
  mergeSessions,
  type DayGroup,
  type SessionListItem,
} from "../lib/mergeSessions";

export interface SessionsIndex {
  items: SessionListItem[];
  dayGroups: DayGroup[];
  pendingCount: number;
  /** True when the last server fetch succeeded (list includes server rows). */
  isServerBacked: boolean;
}

// ---- Shared server-sessions store (one fetch, many subscribers) -----------

let serverSessions: SessionMeta[] | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<(sessions: SessionMeta[] | null) => void>();

function publish(next: SessionMeta[] | null): void {
  serverSessions = next;
  for (const cb of listeners) cb(next);
}

/**
 * Fetch the server sessions once and share the result with every subscribed
 * hook instance. Concurrent callers (multiple mounted hooks, focus events)
 * coalesce onto the same in-flight request.
 */
function fetchServerSessions(): Promise<void> {
  if (!navigator.onLine || !getApiToken()) return Promise.resolve();
  if (inflight) return inflight;
  inflight = apiFetch<SessionsListResponse>("/sessions?limit=100")
    .then((res) => publish(res?.sessions ?? []))
    .catch(() => {
      // Never blocks the list; keep whatever we had.
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Test-only: reset the module-level store between tests. */
export function __resetSessionsIndexStoreForTests(): void {
  serverSessions = null;
  inflight = null;
  listeners.clear();
}

export function useSessionsIndex(): SessionsIndex {
  const { recordings } = useRecordings();
  const online = useOnlineStatus();
  const [server, setServer] = useState<SessionMeta[] | null>(serverSessions);
  const [hasToken, setHasToken] = useState(() => Boolean(getApiToken()));

  // Subscribe to the shared store (and pick up anything fetched since render).
  useEffect(() => {
    setServer(serverSessions);
    const cb = (next: SessionMeta[] | null) => setServer(next);
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }, []);

  useEffect(
    () =>
      onApiTokenChange((token) => {
        setHasToken(Boolean(token));
        // Server rows belong to the old token; drop them when it changes.
        if (!token) publish(null);
      }),
    [],
  );

  const fetchServer = useCallback(() => void fetchServerSessions(), []);

  useEffect(() => {
    if (online && hasToken) fetchServer();
  }, [online, hasToken, fetchServer]);

  useEffect(() => {
    const onFocus = () => fetchServer();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [fetchServer]);

  const items = useMemo(
    () => mergeSessions(recordings, server),
    [recordings, server],
  );
  const dayGroups = useMemo(() => groupByDay(items), [items]);
  const pendingCount = useMemo(
    () => items.filter((i) => i.status === "pending").length,
    [items],
  );

  return { items, dayGroups, pendingCount, isServerBacked: server !== null };
}
