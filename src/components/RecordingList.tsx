/**
 * RecordingList — the history/queue view.
 *
 * Renders all recordings as cards, an empty state, and (when online with
 * pending items) a "back online" CTA banner plus a "Transcribe all pending"
 * action. Connectivity drives which transcribe affordances are enabled; a
 * subtle offline info bar is shown when offline.
 */

import { RecordingItem } from "./RecordingItem";
import { useRecordings } from "../hooks/useRecordings";
import { useOnlineStatus } from "../hooks/useOnlineStatus";
import { MicIcon, RefreshIcon, WifiIcon, WifiOffIcon } from "./icons";

export function RecordingList() {
  const { recordings, stages, transcribeOne, transcribeAllPending, remove } =
    useRecordings();
  const isOnline = useOnlineStatus();

  const pendingCount = recordings.filter((r) => r.status === "pending").length;

  if (recordings.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-[#1e293b] bg-[#0f172a] px-6 py-12 text-center">
        <span className="text-slate-600">
          <MicIcon width={28} height={28} />
        </span>
        <p className="text-sm text-slate-500">
          No recordings yet. Tap the mic above to record — it works offline.
        </p>
      </div>
    );
  }

  return (
    <div>
      {/* Back-online CTA banner: only when online AND there are pending items. */}
      {isOnline && pendingCount > 0 && (
        <div className="mb-4 flex items-center gap-3 rounded-2xl border border-green-500/40 bg-gradient-to-br from-green-500/[0.16] to-indigo-600/[0.14] px-4 py-3.5">
          <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-xl bg-green-500/15 text-green-400">
            <WifiIcon width={20} height={20} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-bold">You're back online</div>
            <div className="mt-0.5 text-xs text-slate-400">
              {pendingCount} recording{pendingCount === 1 ? "" : "s"} ready to
              transcribe
            </div>
          </div>
          <button
            type="button"
            onClick={() => void transcribeAllPending()}
            className="whitespace-nowrap rounded-[11px] bg-indigo-600 px-3.5 py-2 text-[13px] font-bold text-white shadow-lg shadow-indigo-600/40 hover:bg-indigo-500"
          >
            Transcribe all
          </button>
        </div>
      )}

      {/* Offline info bar. */}
      {!isOnline && (
        <div className="mb-4 flex items-center gap-2.5 rounded-2xl border border-amber-500/25 bg-amber-500/[0.08] px-3.5 py-2.5 text-[12.5px] leading-snug text-[#fcd9a4]">
          <WifiOffIcon width={18} height={18} className="shrink-0 text-amber-400" />
          Playback works offline. Pending recordings will transcribe
          automatically once you reconnect.
        </div>
      )}

      {/* List header with count + transcribe-all action. */}
      <div className="flex items-center justify-between px-1 pb-3">
        <span className="text-xs font-semibold text-slate-500">
          {recordings.length} recording{recordings.length === 1 ? "" : "s"}
          {pendingCount > 0 ? ` · ${pendingCount} pending` : ""}
        </span>
        {isOnline ? (
          <button
            type="button"
            onClick={() => void transcribeAllPending()}
            disabled={pendingCount === 0}
            className="inline-flex items-center gap-1.5 rounded-[10px] border border-indigo-500/40 bg-indigo-500/15 px-2.5 py-1.5 text-xs font-bold text-indigo-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshIcon width={13} height={13} />
            Transcribe pending
          </button>
        ) : (
          <span
            aria-disabled="true"
            className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-[10px] border border-[#1e293b] bg-[#0f172a] px-2.5 py-1.5 text-xs font-bold text-slate-600"
          >
            <WifiOffIcon width={13} height={13} />
            Offline
          </span>
        )}
      </div>

      {recordings.map((rec) => (
        <RecordingItem
          key={rec.id}
          recording={rec}
          isOnline={isOnline}
          stage={stages[rec.id]}
          onTranscribe={(id) => void transcribeOne(id)}
          onDelete={(id) => void remove(id)}
        />
      ))}
    </div>
  );
}
