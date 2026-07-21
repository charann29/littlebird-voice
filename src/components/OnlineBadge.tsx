import { useEffect, useState } from "react";
import { useOnlineStatus } from "../hooks/useOnlineStatus";
import { getPendingOpCount, onOutboxSettled } from "../lib/sync";
import { WifiIcon, WifiOffIcon } from "./icons";

/** Poll interval for the pending-op count (enqueues don't emit events). */
const PENDING_POLL_MS = 5_000;

/**
 * "synced / n pending" sync indicator driven by the outbox
 * (lib/sync.getPendingOpCount). Refreshes after every drain
 * (onOutboxSettled) plus a light poll to catch new enqueues.
 * Flagged for design pass.
 */
function SyncBadge() {
  const [pending, setPending] = useState<number | null>(null);

  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      getPendingOpCount()
        .then((n) => {
          if (!disposed) setPending(n);
        })
        .catch(() => {
          /* badge is best-effort */
        });
    };
    refresh();
    const unsubscribe = onOutboxSettled(refresh);
    const timer = setInterval(refresh, PENDING_POLL_MS);
    return () => {
      disposed = true;
      unsubscribe();
      clearInterval(timer);
    };
  }, []);

  if (pending === null) return null;
  const synced = pending === 0;
  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold",
        synced
          ? "border-slate-700 bg-slate-800/60 text-slate-400"
          : "border-indigo-500/30 bg-indigo-500/10 text-indigo-300",
      ].join(" ")}
      title={
        synced
          ? "All changes synced to the server"
          : `${pending} change${pending === 1 ? "" : "s"} waiting to sync`
      }
    >
      {synced ? "Synced" : `${pending} pending`}
    </span>
  );
}

/**
 * Pill badge reflecting live network status. Green "Online" (WifiIcon) vs.
 * amber "Offline" (WifiOffIcon). Driven by useOnlineStatus, which is a UI hint
 * only (see the hook's note on navigator.onLine). Paired with a "synced /
 * n pending" outbox indicator.
 */
export function OnlineBadge() {
  const online = useOnlineStatus();

  return (
    <span className="inline-flex items-center gap-1.5">
      <SyncBadge />
      <span
        className={[
          "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold",
          online
            ? "border-green-500/30 bg-green-500/10 text-green-400"
            : "border-amber-500/30 bg-amber-500/10 text-amber-500",
        ].join(" ")}
      >
        {online ? (
          <WifiIcon className="h-3.5 w-3.5" />
        ) : (
          <WifiOffIcon className="h-3.5 w-3.5" />
        )}
        {online ? "Online" : "Offline"}
      </span>
    </span>
  );
}
