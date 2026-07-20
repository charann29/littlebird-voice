import { useEffect, useMemo, useState } from "react";
import { RecordingsProvider, useRecordings } from "./hooks/useRecordings";
import { useOnlineStatus } from "./hooks/useOnlineStatus";
import { OnlineBadge } from "./components/OnlineBadge";
import { LiveTranscription } from "./components/LiveTranscription";
import { Recorder } from "./components/Recorder";
import { RecordingList } from "./components/RecordingList";
import { DownloadIcon, MicIcon, RefreshIcon } from "./components/icons";

type Tab = "live" | "recorder" | "recordings";

// Minimal BeforeInstallPromptEvent typing (not in lib.dom).
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function BrandLogo() {
  return (
    <div
      className="flex h-9 w-9 items-center justify-center rounded-xl text-white shadow-lg"
      style={{
        background: "linear-gradient(150deg, #4f46e5, #7c3aed)",
        boxShadow: "0 6px 16px -6px rgba(79,70,229,.7)",
      }}
      aria-hidden="true"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff">
        <path d="M21 6c-1.6-.4-3.2 0-4.5 1C15 5.3 12.6 4.5 10 5 6 5.7 3 9 3 13c0 3 1.8 5.3 4 6l-1 3 3-1.2c.7.1 1.4.2 2 .2 4.4 0 8-3.1 8-7 0-1 0-1.9-.4-2.7L21 9V6ZM9 12a1.2 1.2 0 1 1 0-2.4A1.2 1.2 0 0 1 9 12Z" />
      </svg>
    </div>
  );
}

/** Banner shown when a new service-worker version is ready (prompt updates). */
function UpdateBanner() {
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

/** Inline install affordance driven by beforeinstallprompt (+ iOS guidance). */
function InstallBanner() {
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
        <div className="text-sm font-bold text-white">Install littlebird-voice</div>
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
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  badge?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        "flex-1 rounded-xl px-3 py-2 text-sm font-semibold transition-colors",
        active
          ? "bg-indigo-600 text-white"
          : "text-slate-400 hover:text-slate-200",
      ].join(" ")}
    >
      {label}
      {badge ? (
        <span className="ml-1.5 rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[11px] font-bold text-amber-300">
          {badge}
        </span>
      ) : null}
    </button>
  );
}

function Shell() {
  const [tab, setTab] = useState<Tab>("live");
  const online = useOnlineStatus();
  const { recordings } = useRecordings();
  const pendingCount = recordings.filter((r) => r.status === "pending").length;

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-2xl flex-col px-4 pb-6">
      {/* header */}
      <header className="flex items-center justify-between pt-6 pb-2">
        <div className="flex items-center gap-3">
          <BrandLogo />
          <div>
            <h1 className="text-lg font-bold tracking-tight text-white">
              littlebird-voice
            </h1>
            <p className="text-[11px] text-slate-500">Voice notes, even offline</p>
          </div>
        </div>
        <OnlineBadge />
      </header>

      <UpdateBanner />
      <InstallBanner />

      {/* tabs */}
      <nav className="mt-3 flex gap-1 rounded-2xl border border-slate-800 bg-slate-900/60 p-1">
        <TabButton
          active={tab === "live"}
          onClick={() => setTab("live")}
          label="Live"
        />
        <TabButton
          active={tab === "recorder"}
          onClick={() => setTab("recorder")}
          label="Recorder"
        />
        <TabButton
          active={tab === "recordings"}
          onClick={() => setTab("recordings")}
          label="Recordings"
          badge={pendingCount || undefined}
        />
      </nav>

      {/* content */}
      <main className="mt-4 flex flex-1 flex-col">
        {tab === "live" && <LiveTranscription online={online} />}
        {tab === "recorder" && <Recorder />}
        {tab === "recordings" && <RecordingList />}
      </main>

      {/* offline hint when on Live tab */}
      {tab === "live" && !online && (
        <button
          onClick={() => setTab("recorder")}
          className="mt-3 flex items-center justify-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm font-medium text-amber-300"
        >
          <MicIcon className="h-4 w-4" />
          You're offline — record here and transcribe later
        </button>
      )}
    </div>
  );
}

export default function App() {
  return (
    <RecordingsProvider>
      <Shell />
    </RecordingsProvider>
  );
}
