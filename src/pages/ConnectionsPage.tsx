/**
 * ConnectionsPage — thin host for section 40's ConnectionsSettings at
 * /settings/connections (the exact path 40's OAuth callback redirects to;
 * ?connected= / ?error= query params stay reachable here).
 *
 * INTEGRATION POINT (section 40-T3): replace the placeholder below with
 *   import { ConnectionsSettings } from "../components/ConnectionsSettings";
 * once that component lands on the branch.
 */
import { useSearchParams } from "react-router";
import { PlugIcon } from "../components/shell/shellIcons";

export function ConnectionsPage() {
  const [params] = useSearchParams();
  const connected = params.get("connected");
  const error = params.get("error");

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      {connected && (
        <div className="rounded-2xl border border-green-500/40 bg-green-500/10 px-4 py-3 text-sm text-green-300">
          Connected: {connected}
        </div>
      )}
      {error && (
        <div className="rounded-2xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          Connection failed: {error}
        </div>
      )}

      <div className="flex flex-col items-center gap-3 rounded-2xl border border-[#1e293b] bg-[#0f172a] px-6 py-12 text-center">
        <span className="text-slate-600">
          <PlugIcon width={28} height={28} />
        </span>
        <p className="text-sm font-semibold text-slate-300">
          Integrations are on their way
        </p>
        <p className="max-w-sm text-[13px] leading-relaxed text-slate-500">
          Google Calendar, Gmail, Slack, and Notion connections arrive with
          the integrations slice. This page is their future home — OAuth
          returns land here.
        </p>
      </div>
    </div>
  );
}
