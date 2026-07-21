import { useEffect, useMemo, useState } from "react";
import { DownloadIcon } from "../icons";

// Minimal BeforeInstallPromptEvent typing (not in lib.dom).
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/**
 * Inline install affordance driven by beforeinstallprompt (+ iOS guidance).
 * Extracted from v1 App.tsx, behavior unchanged.
 */
export function InstallBanner() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(
    null,
  );
  const [dismissed, setDismissed] = useState(false);
  const [installed, setInstalled] = useState(
    () =>
      window.matchMedia?.("(display-mode: standalone)").matches ||
      // iOS Safari
      (navigator as unknown as { standalone?: boolean }).standalone === true,
  );

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setInstalled(true);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const isIos = useMemo(
    () =>
      /iphone|ipad|ipod/i.test(navigator.userAgent) &&
      !(navigator as unknown as { standalone?: boolean }).standalone,
    [],
  );

  if (installed || dismissed) return null;
  // Show if we have a deferred prompt (Chromium) or on iOS (manual guidance).
  if (!deferred && !isIos) return null;

  return (
    <div
      className="relative mx-4 mt-3 flex items-center gap-3 rounded-2xl border px-4 py-3"
      style={{
        borderColor: "rgba(99,102,241,.4)",
        background:
          "linear-gradient(120deg, rgba(79,70,229,.20), rgba(124,58,237,.16))",
      }}
    >
      <div
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white"
        style={{ background: "linear-gradient(150deg, #4f46e5, #7c3aed)" }}
      >
        <DownloadIcon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-bold text-white">
          Install littlebird-voice
        </div>
        <div className="mt-0.5 text-xs text-slate-400">
          {isIos
            ? "Tap Share, then “Add to Home Screen”. Works offline once installed."
            : "Add to your home screen — records even offline."}
        </div>
      </div>
      {deferred && (
        <button
          onClick={async () => {
            await deferred.prompt();
            await deferred.userChoice;
            setDeferred(null);
          }}
          className="shrink-0 rounded-xl bg-indigo-600 px-3 py-2 text-sm font-bold text-white hover:bg-indigo-500"
        >
          Install
        </button>
      )}
      <button
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        className="absolute right-2 top-2 text-slate-500 hover:text-slate-300"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
        >
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
