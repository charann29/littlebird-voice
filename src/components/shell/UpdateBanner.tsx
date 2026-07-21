import { useEffect, useState } from "react";
import { RefreshIcon } from "../icons";

/**
 * Banner shown when a new service-worker version is ready (prompt updates —
 * never auto-reloads). Extracted from v1 App.tsx, behavior unchanged.
 */
export function UpdateBanner() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onNeed = () => setShow(true);
    window.addEventListener("pwa:need-refresh", onNeed);
    return () => window.removeEventListener("pwa:need-refresh", onNeed);
  }, []);
  if (!show) return null;
  return (
    <div className="mx-4 mt-3 flex items-center gap-3 rounded-2xl border border-indigo-500/40 bg-indigo-500/10 px-4 py-3">
      <RefreshIcon className="h-5 w-5 shrink-0 text-indigo-300" />
      <div className="flex-1 text-sm text-slate-200">
        A new version is available.
      </div>
      <button
        onClick={() => {
          window.dispatchEvent(new CustomEvent("pwa:apply-update"));
          setShow(false);
        }}
        className="shrink-0 rounded-xl bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500"
      >
        Reload
      </button>
    </div>
  );
}
