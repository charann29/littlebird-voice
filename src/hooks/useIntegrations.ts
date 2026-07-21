/**
 * useIntegrations — provider connection state for Settings → Connections.
 *
 * - Fetches GET /api/integrations on mount (online + token set); offline or
 *   unauthenticated renders the four providers as a disconnected, disabled
 *   list rather than erroring (graceful degradation).
 * - `connect(provider)` POSTs /connect and full-page-navigates to the
 *   returned `authorizeUrl` (OAuth consent). The Worker callback lands the
 *   browser back on /settings/connections?connected=<p> | ?error=<code>.
 * - `disconnect(provider)` DELETEs and refreshes the list.
 * - Reads and clears the ?connected/?error return params (via react-router
 *   search params) so a refresh doesn't replay the banner.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { getApiToken } from "../lib/api";
import {
  INTEGRATION_PROVIDERS,
  connectIntegration,
  disconnectIntegration,
  integrationErrorMessage,
  listIntegrations,
  type IntegrationProvider,
  type ProviderState,
} from "../lib/integrations-api";
import { useOnlineStatus } from "./useOnlineStatus";

export type IntegrationsStatus = "loading" | "ready" | "unavailable";

/** Per-provider transient action state (connect/disconnect in flight). */
export type ProviderBusy = "connect" | "disconnect" | null;

export interface OAuthReturn {
  kind: "connected" | "error";
  /** Provider slug for `connected`, short error code for `error`. */
  value: string;
}

export interface UseIntegrationsResult {
  providers: ProviderState[];
  status: IntegrationsStatus;
  /** Message when the list itself could not be loaded (null when ok). */
  error: string | null;
  /** True when actions can't work: offline or no API token. */
  offline: boolean;
  busy: Partial<Record<IntegrationProvider, ProviderBusy>>;
  /** Last action failure per provider (cleared on next action). */
  actionError: Partial<Record<IntegrationProvider, string>>;
  /** Parsed ?connected= / ?error= OAuth return banner (null when absent). */
  oauthReturn: OAuthReturn | null;
  dismissOauthReturn: () => void;
  connect: (provider: IntegrationProvider) => Promise<void>;
  disconnect: (provider: IntegrationProvider) => Promise<void>;
  refresh: () => Promise<void>;
}

/** All four providers rendered as not-connected (offline/unauth fallback). */
export function defaultProviders(): ProviderState[] {
  return INTEGRATION_PROVIDERS.map((provider) => ({
    provider,
    connected: false,
  }));
}

/** Keep the server's ordering intent but always render all four providers. */
export function normalizeProviders(list: ProviderState[]): ProviderState[] {
  const byProvider = new Map(list.map((p) => [p.provider, p]));
  return INTEGRATION_PROVIDERS.map(
    (provider) => byProvider.get(provider) ?? { provider, connected: false },
  );
}

export function useIntegrations(): UseIntegrationsResult {
  const online = useOnlineStatus();
  const hasToken = Boolean(getApiToken());
  const offline = !online || !hasToken;

  const [providers, setProviders] = useState<ProviderState[]>(defaultProviders);
  const [status, setStatus] = useState<IntegrationsStatus>(
    offline ? "unavailable" : "loading",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<
    Partial<Record<IntegrationProvider, ProviderBusy>>
  >({});
  const [actionError, setActionError] = useState<
    Partial<Record<IntegrationProvider, string>>
  >({});
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (!navigator.onLine || !getApiToken()) {
      setStatus("unavailable");
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await listIntegrations(controller.signal);
      if (controller.signal.aborted) return;
      setProviders(normalizeProviders(res?.providers ?? []));
      setStatus("ready");
      setError(null);
    } catch (err) {
      if (controller.signal.aborted) return;
      setStatus("unavailable");
      setError(integrationErrorMessage(err));
    }
  }, []);

  useEffect(() => {
    if (!offline) void refresh();
    else setStatus("unavailable");
    return () => abortRef.current?.abort();
  }, [offline, refresh]);

  // ---- OAuth return params (?connected= / ?error=) ----
  const [searchParams, setSearchParams] = useSearchParams();
  const connectedParam = searchParams.get("connected");
  const errorParam = searchParams.get("error");
  const [oauthReturn, setOauthReturn] = useState<OAuthReturn | null>(() =>
    connectedParam
      ? { kind: "connected", value: connectedParam }
      : errorParam
        ? { kind: "error", value: errorParam }
        : null,
  );

  // Strip the params from the URL once captured (refresh must not replay).
  useEffect(() => {
    if (!connectedParam && !errorParam) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("connected");
        next.delete("error");
        return next;
      },
      { replace: true },
    );
  }, [connectedParam, errorParam, setSearchParams]);

  const dismissOauthReturn = useCallback(() => setOauthReturn(null), []);

  // ---- Actions ----
  const connect = useCallback(async (provider: IntegrationProvider) => {
    setBusy((b) => ({ ...b, [provider]: "connect" }));
    setActionError((e) => ({ ...e, [provider]: undefined }));
    try {
      const { authorizeUrl } = await connectIntegration(
        provider,
        "/settings/connections",
      );
      // Full-page redirect to the provider consent screen. The busy flag
      // intentionally stays set — the page is about to navigate away.
      window.location.assign(authorizeUrl);
    } catch (err) {
      setBusy((b) => ({ ...b, [provider]: null }));
      setActionError((e) => ({
        ...e,
        [provider]: integrationErrorMessage(err),
      }));
    }
  }, []);

  const disconnect = useCallback(
    async (provider: IntegrationProvider) => {
      setBusy((b) => ({ ...b, [provider]: "disconnect" }));
      setActionError((e) => ({ ...e, [provider]: undefined }));
      try {
        await disconnectIntegration(provider);
        // Optimistically flip locally, then re-sync with the server.
        setProviders((prev) =>
          prev.map((p) =>
            p.provider === provider ? { provider, connected: false } : p,
          ),
        );
        await refresh();
      } catch (err) {
        setActionError((e) => ({
          ...e,
          [provider]: integrationErrorMessage(err),
        }));
      } finally {
        setBusy((b) => ({ ...b, [provider]: null }));
      }
    },
    [refresh],
  );

  return {
    providers,
    status,
    error,
    offline,
    busy,
    actionError,
    oauthReturn,
    dismissOauthReturn,
    connect,
    disconnect,
    refresh,
  };
}
