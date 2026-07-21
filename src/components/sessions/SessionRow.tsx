/**
 * SessionRow — one merged session in the day-grouped list (adapted from
 * RecordingItem). Icon tile by source, title, meta line (source tag pill,
 * time · duration, "Captured offline" hint), status pill, chevron. Row click
 * navigates to /sessions/:id; pending/error rows keep their inline
 * Transcribe/Retry affordances (local rows only). Play/copy/delete live on
 * the detail page.
 */
import { useNavigate } from "react-router";
import type { SessionListItem } from "../../lib/mergeSessions";
import type { TranscribeStage } from "../../types";
import { StatusPill } from "./StatusPill";
import {
  MicIcon,
  MonitorIcon,
  RefreshIcon,
  TabIcon,
  WifiOffIcon,
} from "../icons";
import { ChevronRightIcon, UsersIcon } from "../shell/shellIcons";

export const SOURCE_LABEL = {
  mic: "Mic",
  tab: "Tab + Mic",
  screen: "Screen + Mic",
} as const;

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function SourceIcon({ source }: { source: SessionListItem["source"] }) {
  if (source === "tab") return <TabIcon width={10} height={10} />;
  if (source === "screen") return <MonitorIcon width={10} height={10} />;
  return <MicIcon width={10} height={10} />;
}

export function SessionRow({
  item,
  isOnline,
  stage,
  isActive = false,
  onTranscribe,
}: {
  item: SessionListItem;
  isOnline: boolean;
  stage?: TranscribeStage;
  /** True while a transcription is in flight for this id. */
  isActive?: boolean;
  onTranscribe?: (id: string) => void;
}) {
  const navigate = useNavigate();
  const isMeeting = item.source !== "mic";
  const busy = item.status === "transcribing" || isActive;
  const canTranscribe =
    item.hasLocalAudio &&
    (item.status === "pending" || item.status === "error") &&
    onTranscribe;

  return (
    <div
      role="link"
      tabIndex={0}
      aria-label={item.title}
      onClick={() => navigate(`/sessions/${item.id}`)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          navigate(`/sessions/${item.id}`);
        }
      }}
      className="mb-2.5 flex cursor-pointer items-center gap-3.5 rounded-2xl border border-[#1e293b] bg-[#0f172a] px-4 py-3.5 hover:border-[#334155]"
    >
      <div
        className={[
          "flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-xl border",
          isMeeting
            ? "border-indigo-500/30 bg-indigo-500/[0.14] text-indigo-200"
            : "border-[#1e293b] bg-[#111a2e] text-slate-400",
        ].join(" ")}
      >
        {isMeeting ? (
          <UsersIcon width={17} height={17} />
        ) : (
          <MicIcon width={17} height={17} />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="truncate text-[14.5px] font-semibold text-white">
          {item.title}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[#334155] bg-[#111a2e] px-2 py-0.5 text-[10.5px] font-bold text-slate-400">
            <SourceIcon source={item.source} />
            {SOURCE_LABEL[item.source]}
          </span>
          <span>
            {formatTime(item.createdAt)} · {formatDuration(item.durationMs)}
          </span>
          {item.status === "pending" && item.hasLocalAudio && (
            <span>Captured offline</span>
          )}
          {item.isServerOnly && <span>Synced from server</span>}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2.5">
        {canTranscribe &&
          (isOnline ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onTranscribe(item.id);
              }}
              disabled={busy}
              className={
                item.status === "error"
                  ? "inline-flex items-center gap-1.5 rounded-[10px] border border-red-500/35 bg-red-500/10 px-2.5 py-1.5 text-xs font-semibold text-red-300 hover:bg-red-500/15 disabled:opacity-60"
                  : "inline-flex items-center gap-1.5 rounded-[10px] bg-indigo-600 px-2.5 py-1.5 text-xs font-semibold text-white shadow-md shadow-indigo-600/40 hover:bg-indigo-500 disabled:opacity-60"
              }
            >
              {item.status === "error" ? (
                <>
                  <RefreshIcon width={12} height={12} />
                  Retry
                </>
              ) : (
                <>
                  <MicIcon width={12} height={12} />
                  Transcribe
                </>
              )}
            </button>
          ) : (
            <span className="hidden items-center gap-1.5 text-[11px] font-semibold text-amber-400 sm:inline-flex">
              <WifiOffIcon width={12} height={12} />
              Offline
            </span>
          ))}
        <StatusPill
          status={item.status}
          stage={stage}
          hasSummary={item.hasSummary}
        />
        <ChevronRightIcon width={16} height={16} className="text-slate-600" />
      </div>
    </div>
  );
}
