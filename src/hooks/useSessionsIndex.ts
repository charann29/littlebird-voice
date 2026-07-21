/**
 * useSessionsIndex — the merged (local IndexedDB + server) sessions list.
 *
 * Hydrates from useRecordings().recordings (already reactive) instantly and
 * with zero network; overlays GET /api/sessions?limit=100 when online with a
 * token set. Re-fetches on `online` events and window focus. No polling.
 * Server failure degrades silently to the local-only list.
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

export function useSessionsIndex(): SessionsIndex {
  const { recordings } = useRecordings();
  const online = useOnlineStatus();
  const [server, setServer] = useState<SessionMeta[] | null>(null);
  const [hasToken, setHasToken] = useState(() => Boolean(getApiToken()));

  useEffect(
    () => onApiTokenChange((token) => setHasToken(Boolean(token))),
    [],
  );

  const fetchServer = useCallback(async () => {
    if (!navigator.onLine || !getApiToken()) return;
    try {
      const res = await apiFetch<SessionsListResponse>("/sessions?limit=100");
      setServer(res?.sessions ?? []);
    } catch {
      // Never blocks the list; keep whatever we had.
    }
  }, []);

  useEffect(() => {
    if (online && hasToken) void fetchServer();
  }, [online, hasToken, fetchServer]);

  useEffect(() => {
    const onFocus = () => void fetchServer();
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
