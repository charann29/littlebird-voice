/**
 * useSessionDetail(id) — local getRecording(id) and (when online + token)
 * GET /api/sessions/:id loaded in parallel; neither blocks the other. Both
 * missing after both settle → notFound.
 */
import { useCallback, useEffect, useState } from "react";
import { getRecording } from "../lib/db";
import { apiFetch, getApiToken } from "../lib/api";
import { useOnlineStatus } from "./useOnlineStatus";
import type { SessionDetailResponse } from "../lib/api-types";
import type { Recording } from "../types";

export interface SessionDetail {
  local: Recording | null;
  server: SessionDetailResponse | null;
  /** True once the local read has settled. */
  localLoaded: boolean;
  /** True once the server fetch settled (or was skipped: offline/no token). */
  serverSettled: boolean;
  notFound: boolean;
  refreshLocal: () => Promise<void>;
}

export function useSessionDetail(id: string | undefined): SessionDetail {
  const online = useOnlineStatus();
  const [local, setLocal] = useState<Recording | null>(null);
  const [localLoaded, setLocalLoaded] = useState(false);
  const [server, setServer] = useState<SessionDetailResponse | null>(null);
  const [serverSettled, setServerSettled] = useState(false);

  const refreshLocal = useCallback(async () => {
    if (!id) return;
    const rec = await getRecording(id);
    setLocal(rec ?? null);
    setLocalLoaded(true);
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    setLocal(null);
    setLocalLoaded(false);
    if (!id) return;
    void getRecording(id).then((rec) => {
      if (cancelled) return;
      setLocal(rec ?? null);
      setLocalLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    setServer(null);
    setServerSettled(false);
    if (!id || !online || !getApiToken()) {
      setServerSettled(true);
      return;
    }
    void apiFetch<SessionDetailResponse>(`/sessions/${id}`)
      .then((res) => {
        if (!cancelled) setServer(res ?? null);
      })
      .catch(() => {
        /* 404 / network — server side simply absent */
      })
      .finally(() => {
        if (!cancelled) setServerSettled(true);
      });
    return () => {
      cancelled = true;
    };
  }, [id, online]);

  return {
    local,
    server,
    localLoaded,
    serverSettled,
    notFound: localLoaded && serverSettled && !local && !server,
    refreshLocal,
  };
}
