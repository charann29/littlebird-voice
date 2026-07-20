/**
 * RecordingItem — a single recording card in the history/queue list.
 *
 * Shows timestamp, duration, a status pill, offline-capable audio playback,
 * a transcript preview with Copy, and lifecycle actions (Transcribe / Retry /
 * Delete). Playback works offline via an object URL created from the stored
 * Blob; the URL is revoked when the blob changes or the item unmounts to avoid
 * leaking memory.
 */

import { useEffect, useRef, useState } from "react";
import type { Recording, TranscribeStage } from "../types";
import {
  AlertIcon,
  CheckIcon,
  CopyIcon,
  MicIcon,
  PauseIcon,
  PlayIcon,
  RefreshIcon,
  SpinnerIcon,
  TrashIcon,
  WifiOffIcon,
} from "./icons";

interface RecordingItemProps {
  recording: Recording;
  isOnline: boolean;
  stage?: TranscribeStage;
  /** True while a transcription is in flight for this id (immediate). */
  isActive?: boolean;
  onTranscribe: (id: string) => void;
  onDelete: (id: string) => void;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  if (sameDay) return `Today · ${time}`;
  if (isYesterday) return `Yesterday · ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} · ${time}`;
}

const STAGE_LABEL: Record<TranscribeStage, string> = {
  uploading: "Uploading…",
  creating: "Starting…",
  polling: "Transcribing…",
  fetching: "Finishing…",
};

export function RecordingItem({
  recording,
  isOnline,
  stage,
  isActive = false,
  onTranscribe,
  onDelete,
}: RecordingItemProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);

  // Create the object URL in an effect (not useMemo) so it's created and
  // revoked exactly once per blob — this survives StrictMode's double-invoke
  // and revokes on unmount AND whenever the blob changes.
  const [objectUrl, setObjectUrl] = useState<string>("");
  useEffect(() => {
    const url = URL.createObjectURL(recording.blob);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [recording.blob]);

  const togglePlay = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      void el.play();
    } else {
      el.pause();
    }
  };

  const copyTranscript = async () => {
    if (!recording.transcript) return;
    try {
      await navigator.clipboard.writeText(recording.transcript);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be unavailable; ignore */
    }
  };

  const { status } = recording;
  const isTranscribing = status === "transcribing";
  // Disable transcribe/retry the instant a run is reserved (before the status
  // write lands), defeating rapid double-clicks / click-during-drain races.
  const busy = isTranscribing || isActive;

  const title = `Recording ${formatTimestamp(recording.createdAt)}`;

  return (
    <div className="mb-3 rounded-2xl border border-[#1e293b] bg-[#0f172a] p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold">{title}</div>
          <div className="mt-0.5 text-xs text-slate-500">
            {formatTimestamp(recording.createdAt)} ·{" "}
            {formatDuration(recording.durationMs)}
          </div>
        </div>
        <StatusPill status={status} stage={stage} />
      </div>

      {/* Audio playback — works offline. */}
      <div className="mt-3 flex items-center gap-2.5">
        <button
          type="button"
          onClick={togglePlay}
          aria-label={isPlaying ? "Pause" : "Play"}
          className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full border border-indigo-500/40 bg-indigo-500/15 text-indigo-200"
        >
          {isPlaying ? (
            <PauseIcon width={14} height={14} />
          ) : (
            <PlayIcon width={14} height={14} />
          )}
        </button>
        <div className="relative h-[5px] flex-1 overflow-hidden rounded-full bg-[#111a2e]">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-indigo-600 to-indigo-500"
            style={{
              width: recording.durationMs
                ? `${Math.min(100, (currentMs / recording.durationMs) * 100)}%`
                : "0%",
            }}
          />
        </div>
        <span className="shrink-0 text-[11px] tabular-nums text-slate-500">
          {formatDuration(currentMs)} / {formatDuration(recording.durationMs)}
        </span>
        <audio
          ref={audioRef}
          {...(objectUrl ? { src: objectUrl } : {})}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => {
            setIsPlaying(false);
            setCurrentMs(0);
          }}
          onTimeUpdate={(e) =>
            setCurrentMs(e.currentTarget.currentTime * 1000)
          }
          className="hidden"
        />
      </div>

      {/* Transcript preview / status text. */}
      {status === "done" && recording.transcript ? (
        <div className="mt-3 line-clamp-2 rounded-xl border border-[#1e293b] bg-[#111a2e] px-3 py-2.5 text-[13px] leading-relaxed text-slate-300">
          {recording.transcript}
        </div>
      ) : status === "error" ? (
        <div className="mt-3 rounded-xl border border-[#1e293b] bg-[#111a2e] px-3 py-2.5 text-[13px] italic leading-relaxed text-red-300/90">
          {recording.error || "Transcription failed. Try again."}
        </div>
      ) : status === "pending" ? (
        <div className="mt-3 line-clamp-2 rounded-xl border border-[#1e293b] bg-[#111a2e] px-3 py-2.5 text-[13px] italic leading-relaxed text-slate-600">
          Recorded offline — not transcribed yet.
        </div>
      ) : null}

      {/* Actions. */}
      <div className="mt-3 flex items-center gap-2">
        {status === "pending" &&
          (isOnline ? (
            <button
              type="button"
              onClick={() => onTranscribe(recording.id)}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-[10px] bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-md shadow-indigo-600/40 hover:bg-indigo-500 disabled:opacity-60"
            >
              <MicIcon width={13} height={13} />
              Transcribe
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled
                aria-disabled="true"
                className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-[10px] border border-dashed border-[#334155] bg-[#111a2e] px-3 py-1.5 text-xs font-semibold text-slate-600"
              >
                <MicIcon width={13} height={13} />
                Transcribe
              </button>
              <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] font-semibold text-amber-400">
                <WifiOffIcon width={12} height={12} />
                Connect to transcribe
              </span>
            </>
          ))}

        {status === "error" &&
          (isOnline ? (
            <button
              type="button"
              onClick={() => onTranscribe(recording.id)}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-[10px] border border-red-500/35 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-300 hover:bg-red-500/15 disabled:opacity-60"
            >
              <RefreshIcon width={13} height={13} />
              Retry
            </button>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-amber-400">
              <WifiOffIcon width={12} height={12} />
              Connect to retry
            </span>
          ))}

        {status === "done" && recording.transcript && (
          <button
            type="button"
            onClick={copyTranscript}
            className="inline-flex items-center gap-1.5 rounded-[10px] border border-[#1e293b] px-3 py-1.5 text-xs font-semibold text-slate-400 hover:border-[#334155] hover:text-slate-300"
          >
            {copied ? (
              <CheckIcon width={13} height={13} />
            ) : (
              <CopyIcon width={13} height={13} />
            )}
            {copied ? "Copied" : "Copy"}
          </button>
        )}

        <button
          type="button"
          onClick={() => onDelete(recording.id)}
          aria-label="Delete recording"
          className="ml-auto inline-flex items-center gap-1.5 rounded-[10px] border border-[#1e293b] px-3 py-1.5 text-xs font-semibold text-slate-400 hover:border-red-500/40 hover:text-red-300"
        >
          <TrashIcon width={14} height={14} />
        </button>
      </div>
    </div>
  );
}

function StatusPill({
  status,
  stage,
}: {
  status: Recording["status"];
  stage?: TranscribeStage;
}) {
  const base =
    "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-bold";
  switch (status) {
    case "pending":
      return (
        <span
          className={`${base} border-amber-500/30 bg-amber-500/15 text-amber-400`}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-current" />
          Pending
        </span>
      );
    case "transcribing":
      return (
        <span
          className={`${base} border-indigo-500/40 bg-indigo-500/15 text-indigo-200`}
        >
          <SpinnerIcon width={11} height={11} />
          {stage ? STAGE_LABEL[stage] : "Transcribing…"}
        </span>
      );
    case "done":
      return (
        <span
          className={`${base} border-green-500/30 bg-green-500/15 text-green-400`}
        >
          <CheckIcon width={10} height={10} />
          Done
        </span>
      );
    case "error":
      return (
        <span
          className={`${base} border-red-500/35 bg-red-500/15 text-red-300`}
        >
          <AlertIcon width={11} height={11} />
          Error
        </span>
      );
  }
}
