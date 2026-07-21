/**
 * AudioPlayer — local-blob playback for session detail (play/pause, seek
 * track, elapsed/total). URL.createObjectURL(blob) created on mount, revoked
 * on unmount / blob change (effect, not useMemo — StrictMode-safe).
 */
import { useEffect, useRef, useState } from "react";
import { PauseIcon, PlayIcon } from "../icons";

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function AudioPlayer({
  blob,
  durationMs,
}: {
  blob: Blob;
  durationMs: number;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);

  const [objectUrl, setObjectUrl] = useState<string>("");
  useEffect(() => {
    const url = URL.createObjectURL(blob);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [blob]);

  const togglePlay = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play();
    else el.pause();
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = audioRef.current;
    if (!el || !durationMs) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    el.currentTime = (frac * durationMs) / 1000;
    setCurrentMs(frac * durationMs);
  };

  return (
    <div className="mb-4 flex items-center gap-3 rounded-[14px] border border-[#1e293b] bg-[#0f172a] px-3 py-2.5">
      <button
        type="button"
        onClick={togglePlay}
        aria-label={isPlaying ? "Pause" : "Play"}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white"
        style={{
          background: "linear-gradient(160deg, #6366f1, #4f46e5)",
          boxShadow: "0 8px 20px -8px rgba(79,70,229,.7)",
        }}
      >
        {isPlaying ? (
          <PauseIcon width={14} height={14} />
        ) : (
          <PlayIcon width={14} height={14} />
        )}
      </button>
      <div
        className="relative h-[5px] flex-1 cursor-pointer overflow-hidden rounded-full bg-[#111a2e]"
        onClick={seek}
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(durationMs / 1000)}
        aria-valuenow={Math.round(currentMs / 1000)}
        tabIndex={0}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-indigo-600 to-indigo-500"
          style={{
            width: durationMs
              ? `${Math.min(100, (currentMs / durationMs) * 100)}%`
              : "0%",
          }}
        />
      </div>
      <span className="shrink-0 text-[11px] tabular-nums text-slate-500">
        {formatDuration(currentMs)} / {formatDuration(durationMs)}
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
        onTimeUpdate={(e) => setCurrentMs(e.currentTarget.currentTime * 1000)}
        className="hidden"
      />
    </div>
  );
}
