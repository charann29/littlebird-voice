/**
 * Settings & Privacy — API token card (paste/rotate the app bearer token,
 * validated via authenticated GET /api/auth/check) + static privacy card +
 * link to /settings/connections.
 *
 * Validation semantics: 204 → Connected; 401 → Invalid token; network
 * error → Server unreachable (a network failure is NOT a bad token).
 * Saving a token triggers an outbox drain (setApiToken fires
 * onApiTokenChange → sync drain; we also call drainOutbox() explicitly as
 * the belt-and-braces UX confirmation the section-10 spec asks for).
 */
import { useEffect, useState } from "react";
import { Link } from "react-router";
import {
  ApiError,
  apiFetch,
  getApiToken,
  onApiTokenChange,
  setApiToken,
} from "../lib/api";
import { drainOutbox } from "../lib/sync";
import { PlugIcon, ShieldIcon } from "../components/shell/shellIcons";
import { CheckIcon, AlertIcon, SpinnerIcon } from "../components/icons";

type TokenStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "connected" }
  | { kind: "invalid" }
  | { kind: "unreachable" }
  | { kind: "disconnected" };

export async function checkToken(): Promise<
  "connected" | "invalid" | "unreachable"
> {
  try {
    await apiFetch("/auth/check");
    return "connected";
  } catch (err) {
    if (err instanceof ApiError) {
      return err.status === 401 ? "invalid" : "unreachable";
    }
    // fetch threw (offline / server down) — NOT an invalid token.
    return "unreachable";
  }
}

function Card({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-[#1e293b] bg-[#0f172a] p-5">
      <h3 className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[.08em] text-slate-500">
        {icon}
        {title}
      </h3>
      <div className="mt-3.5">{children}</div>
    </section>
  );
}

export function SettingsPage() {
  const [hasToken, setHasToken] = useState(() => Boolean(getApiToken()));
  const [draft, setDraft] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [status, setStatus] = useState<TokenStatus>({ kind: "idle" });

  useEffect(
    () => onApiTokenChange((token) => setHasToken(Boolean(token))),
    [],
  );

  // On mount with a stored token, verify it silently.
  useEffect(() => {
    if (!getApiToken()) return;
    let cancelled = false;
    void checkToken().then((result) => {
      if (!cancelled) setStatus({ kind: result });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setStatus({ kind: "checking" });
    setApiToken(trimmed);
    const result = await checkToken();
    setStatus({ kind: result });
    if (result === "connected") {
      // Explicit drain on a valid token save (spec: token set/changed is an
      // outbox-drain trigger; onApiTokenChange fires the same drain).
      void drainOutbox();
      setDraft("");
    }
  };

  const disconnect = () => {
    setApiToken(null);
    setDraft("");
    setStatus({ kind: "disconnected" });
  };

  const statusLine = (() => {
    switch (status.kind) {
      case "checking":
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-indigo-300">
            <SpinnerIcon width={12} height={12} /> Checking…
          </span>
        );
      case "connected":
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-green-400">
            <CheckIcon width={12} height={12} /> Connected
          </span>
        );
      case "invalid":
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-300">
            <AlertIcon width={12} height={12} /> Invalid token
          </span>
        );
      case "unreachable":
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-400">
            <AlertIcon width={12} height={12} /> Server unreachable
          </span>
        );
      case "disconnected":
        return (
          <span className="text-xs font-semibold text-slate-500">
            Disconnected — sync is paused
          </span>
        );
      default:
        return hasToken ? null : (
          <span className="text-xs font-semibold text-slate-500">
            Not connected
          </span>
        );
    }
  })();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <Card
        title="API token"
        icon={<ShieldIcon width={13} height={13} className="text-slate-600" />}
      >
        <p className="text-[13px] leading-relaxed text-slate-400">
          Paste the app bearer token to sync transcripts and titles to your
          own Cloudflare Worker. The token comes from the Worker's{" "}
          <code className="rounded bg-[#111a2e] px-1 py-0.5 text-[12px]">
            APP_AUTH_TOKEN
          </code>{" "}
          secret — see <code className="rounded bg-[#111a2e] px-1 py-0.5 text-[12px]">worker/README.md</code>.
        </p>

        <div className="mt-3 flex items-center gap-2">
          <input
            type={showToken ? "text" : "password"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
            }}
            placeholder={hasToken ? "••••••••  (token set)" : "Paste API token"}
            aria-label="API token"
            className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 outline-none focus:border-indigo-500"
          />
          <button
            type="button"
            onClick={() => setShowToken((s) => !s)}
            aria-label={showToken ? "Hide token" : "Show token"}
            className="rounded-xl border border-[#1e293b] px-2.5 py-2 text-xs font-semibold text-slate-400 hover:border-[#334155] hover:text-slate-300"
          >
            {showToken ? "Hide" : "Show"}
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!draft.trim() || status.kind === "checking"}
            className="rounded-xl bg-indigo-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Save
          </button>
        </div>

        <div className="mt-2.5 flex items-center justify-between">
          <span data-testid="token-status">{statusLine}</span>
          {hasToken && (
            <button
              type="button"
              onClick={disconnect}
              className="rounded-[10px] border border-red-500/35 bg-red-500/10 px-2.5 py-1.5 text-xs font-semibold text-red-300 hover:bg-red-500/15"
            >
              Disconnect
            </button>
          )}
        </div>
      </Card>

      <Card
        title="Privacy"
        icon={<ShieldIcon width={13} height={13} className="text-slate-600" />}
      >
        <ul className="flex flex-col gap-2 text-[13px] leading-relaxed text-slate-400">
          <li>
            Audio recordings are stored only in this browser's IndexedDB and
            are <strong className="text-slate-300">never uploaded</strong>.
          </li>
          <li>
            Transcripts, titles, and summaries sync to your own Cloudflare
            Worker.
          </li>
          <li>Deleting a session removes it from both places.</li>
        </ul>
      </Card>

      <Card
        title="Integrations"
        icon={<PlugIcon width={13} height={13} className="text-slate-600" />}
      >
        <p className="text-[13px] leading-relaxed text-slate-400">
          Connect Google Calendar, Gmail, Slack, and Notion.
        </p>
        <Link
          to="/settings/connections"
          className="mt-3 inline-flex items-center gap-1.5 rounded-xl border border-indigo-500/40 bg-indigo-500/15 px-3 py-2 text-sm font-semibold text-indigo-200 no-underline hover:bg-indigo-500/20"
        >
          Manage connections
        </Link>
      </Card>
    </div>
  );
}
