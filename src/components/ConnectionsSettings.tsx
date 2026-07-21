/**
 * ConnectionsSettings — Settings → Connections screen (section 40-T3/T4).
 *
 * Four provider cards (Google Calendar, Gmail, Slack, Notion) with status
 * (Not connected / Connected as <account> / Error → Reconnect), Connect /
 * Disconnect / Reconnect actions, OAuth-return banner (?connected/?error),
 * and — for connected providers — inline action affordances: Calendar
 * upcoming events, Gmail test send, Slack channel post, Notion export/import.
 *
 * Tokens never reach this component: `useIntegrations` only carries provider
 * status/labels, and actions send content + target ids to the Worker.
 * Offline / no-token renders every card disabled with a hint (graceful
 * degradation), never an error wall.
 */
import { Link } from "react-router";
import {
  useIntegrations,
  type UseIntegrationsResult,
} from "../hooks/useIntegrations";
import type {
  IntegrationProvider,
  ProviderState,
} from "../lib/integrations-api";
import {
  CalendarUpcomingEvents,
  GmailSendControl,
  NotionExportControl,
  NotionImportControl,
  SlackPostControl,
} from "./integrations/IntegrationActions";
import { AlertIcon, CheckIcon, RefreshIcon, SpinnerIcon } from "./icons";
import { CloseIcon, PlugIcon } from "./shell/shellIcons";

const PROVIDER_META: Record<
  IntegrationProvider,
  { name: string; description: string }
> = {
  "google-calendar": {
    name: "Google Calendar",
    description: "See upcoming meetings so you can prep and start capture.",
  },
  gmail: {
    name: "Gmail",
    description: "Send drafted follow-up emails from your own address.",
  },
  slack: {
    name: "Slack",
    description: "Post meeting summaries to a channel of your choice.",
  },
  notion: {
    name: "Notion",
    description:
      "Export summaries to a database and import pages into memory search.",
  },
};

export function providerLabel(provider: string): string {
  return (
    PROVIDER_META[provider as IntegrationProvider]?.name ?? provider
  );
}

function StatusBadge({ p }: { p: ProviderState }) {
  if (p.connected && p.status === "error") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/35 bg-amber-500/10 px-2.5 py-1 text-[11px] font-bold text-amber-300">
        <AlertIcon width={11} height={11} /> Needs reconnect
      </span>
    );
  }
  if (p.connected) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-green-500/35 bg-green-500/10 px-2.5 py-1 text-[11px] font-bold text-green-300">
        <CheckIcon width={11} height={11} /> Connected
      </span>
    );
  }
  return (
    <span className="rounded-full border border-[#334155] bg-[#0f172a] px-2.5 py-1 text-[11px] font-bold text-slate-500">
      Not connected
    </span>
  );
}

function ProviderActions({ provider }: { provider: IntegrationProvider }) {
  switch (provider) {
    case "google-calendar":
      return <CalendarUpcomingEvents days={7} />;
    case "gmail":
      return (
        <div className="flex flex-wrap gap-2">
          <GmailSendControl />
        </div>
      );
    case "slack":
      return (
        <div className="flex flex-wrap gap-2">
          <SlackPostControl />
        </div>
      );
    case "notion":
      return (
        <div className="flex flex-wrap gap-2">
          <NotionExportControl />
          <NotionImportControl />
        </div>
      );
  }
}

function ProviderCard({
  p,
  ctx,
}: {
  p: ProviderState;
  ctx: UseIntegrationsResult;
}) {
  const meta = PROVIDER_META[p.provider];
  const busy = ctx.busy[p.provider] ?? null;
  const actionError = ctx.actionError[p.provider];
  const needsReconnect = p.connected && p.status === "error";

  return (
    <section
      data-testid={`provider-card-${p.provider}`}
      className="rounded-2xl border border-[#1e293b] bg-[#0f172a] p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-2 text-sm font-bold text-slate-200">
            {meta.name}
            <StatusBadge p={p} />
          </h3>
          {p.connected && p.displayName ? (
            <p className="mt-1 text-[12.5px] text-slate-400">
              Connected as{" "}
              <span className="font-semibold text-slate-300">
                {p.displayName}
              </span>
              {p.connectedAt ? (
                <span className="text-slate-600">
                  {" · since "}
                  {new Date(p.connectedAt).toLocaleDateString([], {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </span>
              ) : null}
            </p>
          ) : (
            <p className="mt-1 text-[12.5px] leading-relaxed text-slate-500">
              {meta.description}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {p.connected ? (
            <>
              {needsReconnect && (
                <button
                  type="button"
                  onClick={() => void ctx.connect(p.provider)}
                  disabled={ctx.offline || busy !== null}
                  className="inline-flex items-center gap-1.5 rounded-[11px] bg-indigo-600 px-3 py-2 text-[12.5px] font-bold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy === "connect" ? (
                    <SpinnerIcon width={12} height={12} />
                  ) : (
                    <RefreshIcon width={12} height={12} />
                  )}
                  Reconnect
                </button>
              )}
              <button
                type="button"
                onClick={() => void ctx.disconnect(p.provider)}
                disabled={ctx.offline || busy !== null}
                className="inline-flex items-center gap-1.5 rounded-[10px] border border-red-500/35 bg-red-500/10 px-2.5 py-1.5 text-xs font-semibold text-red-300 hover:bg-red-500/15 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === "disconnect" && (
                  <SpinnerIcon width={11} height={11} />
                )}
                Disconnect
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => void ctx.connect(p.provider)}
              disabled={ctx.offline || busy !== null}
              title={
                ctx.offline
                  ? "Connect requires being online with an API token set"
                  : undefined
              }
              className="inline-flex items-center gap-1.5 rounded-[11px] bg-indigo-600 px-3.5 py-2 text-[12.5px] font-bold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === "connect" ? (
                <SpinnerIcon width={12} height={12} />
              ) : (
                <PlugIcon width={12} height={12} />
              )}
              Connect
            </button>
          )}
        </div>
      </div>

      {actionError && (
        <p
          role="alert"
          className="mt-3 rounded-[11px] border border-red-500/30 bg-red-500/[.07] px-3 py-2 text-[12.5px] text-red-200"
        >
          {actionError}
        </p>
      )}

      {needsReconnect && (
        <p className="mt-3 rounded-[11px] border border-amber-500/25 bg-amber-500/[.07] px-3 py-2 text-[12.5px] leading-relaxed text-amber-200/90">
          Access to {meta.name} stopped working (revoked or expired). Reconnect
          to keep using it — your data here is untouched.
        </p>
      )}

      {p.connected && !needsReconnect && (
        <div className="mt-4 border-t border-[#1e293b] pt-4">
          <ProviderActions provider={p.provider} />
        </div>
      )}
    </section>
  );
}

export function ConnectionsSettings() {
  const ctx = useIntegrations();
  const { providers, status, error, offline, oauthReturn, dismissOauthReturn } =
    ctx;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      {oauthReturn && (
        <div
          data-testid="oauth-return-banner"
          className={[
            "flex items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-sm",
            oauthReturn.kind === "connected"
              ? "border-green-500/40 bg-green-500/10 text-green-300"
              : "border-red-500/40 bg-red-500/10 text-red-300",
          ].join(" ")}
        >
          <span className="inline-flex items-center gap-2">
            {oauthReturn.kind === "connected" ? (
              <>
                <CheckIcon width={14} height={14} />
                {providerLabel(oauthReturn.value)} connected
              </>
            ) : (
              <>
                <AlertIcon width={14} height={14} />
                Connection failed ({oauthReturn.value}) — try again
              </>
            )}
          </span>
          <button
            type="button"
            onClick={dismissOauthReturn}
            aria-label="Dismiss"
            className="shrink-0 rounded-lg p-1 hover:bg-white/5"
          >
            <CloseIcon width={13} height={13} />
          </button>
        </div>
      )}

      {offline && (
        <div className="flex items-start gap-2.5 rounded-2xl border border-[#1e293b] bg-[#0f172a] px-4 py-3.5">
          <span className="mt-0.5 shrink-0 text-slate-600">
            <AlertIcon width={14} height={14} />
          </span>
          <p className="text-[13px] leading-relaxed text-slate-400">
            {navigator.onLine === false
              ? "You're offline — connections are read-only until you're back online."
              : (
                  <>
                    Set your API token in{" "}
                    <Link
                      to="/settings"
                      className="font-semibold text-indigo-300 underline"
                    >
                      Settings
                    </Link>{" "}
                    to manage connections.
                  </>
                )}
          </p>
        </div>
      )}

      {!offline && status === "unavailable" && error && (
        <div className="flex items-start gap-2.5 rounded-2xl border border-amber-500/30 bg-amber-500/[.07] px-4 py-3.5">
          <span className="mt-0.5 shrink-0 text-amber-400">
            <AlertIcon width={14} height={14} />
          </span>
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-amber-200">
              Couldn't load connection status
            </p>
            <p className="mt-0.5 text-[12.5px] text-amber-200/80">{error}</p>
            <button
              type="button"
              onClick={() => void ctx.refresh()}
              className="mt-2 inline-flex items-center gap-1.5 rounded-[10px] border border-amber-500/35 px-2.5 py-1.5 text-xs font-semibold text-amber-200 hover:bg-amber-500/10"
            >
              <RefreshIcon width={11} height={11} /> Retry
            </button>
          </div>
        </div>
      )}

      {status === "loading" && (
        <div className="flex items-center gap-2 rounded-2xl border border-[#1e293b] bg-[#0f172a] px-4 py-6 text-[13px] text-slate-500">
          <SpinnerIcon width={14} height={14} /> Loading connections…
        </div>
      )}

      {providers.map((p) => (
        <ProviderCard key={p.provider} p={p} ctx={ctx} />
      ))}

      <p className="px-1 text-[11.5px] leading-relaxed text-slate-600">
        Provider tokens are stored encrypted on your Worker and never reach
        this browser. Disconnecting revokes access and deletes the stored
        tokens.
      </p>
    </div>
  );
}
