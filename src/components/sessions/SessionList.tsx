/**
 * SessionList — day-grouped merged sessions with the v1 list chrome adapted
 * from RecordingList: back-online CTA banner (Transcribe all), offline info
 * bar, count header, empty state, and the mockup's filter chips
 * (All | Meetings | Voice notes).
 */
import { useMemo, useState } from "react";
import { useSessionsIndex } from "../../hooks/useSessionsIndex";
import { useRecordings } from "../../hooks/useRecordings";
import { useOnlineStatus } from "../../hooks/useOnlineStatus";
import { groupByDay } from "../../lib/mergeSessions";
import { SessionRow } from "./SessionRow";
import { MicIcon, RefreshIcon, WifiIcon, WifiOffIcon } from "../icons";

type Filter = "all" | "meetings" | "notes";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "meetings", label: "Meetings" },
  { id: "notes", label: "Voice notes" },
];

export function SessionList() {
  const { items, pendingCount } = useSessionsIndex();
  const { stages, activeIds, transcribeOne, transcribeAllPending } =
    useRecordings();
  const isOnline = useOnlineStatus();
  const [filter, setFilter] = useState<Filter>("all");

  const filtered = useMemo(() => {
    if (filter === "meetings") return items.filter((i) => i.source !== "mic");
    if (filter === "notes") return items.filter((i) => i.source === "mic");
    return items;
  }, [items, filter]);

  const dayGroups = useMemo(() => groupByDay(filtered), [filtered]);

  if (items.length === 0) {
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
    <div className="mx-auto w-full max-w-3xl">
      {/* Back-online CTA banner: only when online AND there are pending items. */}
      {isOnline && pendingCount > 0 && (
        <div className="mb-4 flex items-center gap-3 rounded-2xl border border-green-500/40 bg-gradient-to-br from-green-500/[0.16] to-indigo-600/[0.14] px-4 py-3.5">
          <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-xl bg-green-500/15 text-green-400">
            <WifiIcon width={20} height={20} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-bold text-white">
              You're back online
            </div>
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

      {/* Filters + count header. */}
      <div className="mb-4 flex items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            aria-pressed={filter === f.id}
            className={[
              "rounded-full border px-3 py-1.5 text-[12.5px] font-semibold",
              filter === f.id
                ? "border-indigo-500/55 bg-indigo-500/15 text-indigo-200"
                : "border-[#334155] bg-[#0f172a] text-slate-400 hover:text-slate-300",
            ].join(" ")}
          >
            {f.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2 text-xs font-semibold text-slate-500">
          <span>
            {items.length} session{items.length === 1 ? "" : "s"}
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
      </div>

      {filtered.length === 0 ? (
        <p className="px-1 py-8 text-center text-sm text-slate-500">
          No {filter === "meetings" ? "meetings" : "voice notes"} yet.
        </p>
      ) : (
        dayGroups.map((group) => (
          <section key={group.label} aria-label={group.label}>
            <div className="flex items-center gap-2.5 px-0.5 pb-2.5 pt-1 text-[11px] font-bold uppercase tracking-[.08em] text-slate-500 after:h-px after:flex-1 after:bg-[#1e293b] after:content-['']">
              {group.label}{" "}
              <span className="font-semibold normal-case tracking-normal text-slate-600">
                {group.items.length}
              </span>
            </div>
            {group.items.map((item) => (
              <SessionRow
                key={item.id}
                item={item}
                isOnline={isOnline}
                stage={stages[item.id]}
                isActive={activeIds.includes(item.id)}
                onTranscribe={(id) => void transcribeOne(id)}
              />
            ))}
          </section>
        ))
      )}
    </div>
  );
}
