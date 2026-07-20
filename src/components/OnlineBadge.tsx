import { useOnlineStatus } from "../hooks/useOnlineStatus";
import { WifiIcon, WifiOffIcon } from "./icons";

/**
 * Pill badge reflecting live network status. Green "Online" (WifiIcon) vs.
 * amber "Offline" (WifiOffIcon). Driven by useOnlineStatus, which is a UI hint
 * only (see the hook's note on navigator.onLine).
 */
export function OnlineBadge() {
  const online = useOnlineStatus();

  return (
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
  );
}
