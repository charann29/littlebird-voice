/**
 * Recorder — offline-capable recording UI.
 *
 * The record button is NEVER gated on connectivity: capturing audio is fully
 * local, and that offline-first capability is the whole point of the product.
 * When offline we reassure the user their audio is saved and will transcribe
 * automatically once back online; when online we note it can be transcribed
 * immediately from the list.
 */

import { useCallback, useRef, useState } from "react";
import { DownloadIcon, MicIcon, StopIcon, WifiOffIcon } from "./icons";
import { useRecorder, type CapturedAudio } from "../hooks/useRecorder";
import { useRecordings } from "../hooks/useRecordings";
import { useOnlineStatus } from "../hooks/useOnlineStatus";

function formatTimer(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function extensionForMime(mimeType: string): string {
  const t = mimeType.toLowerCase();
  if (t.includes("webm")) return "webm";
  if (t.includes("mp4") || t.includes("m4a")) return "m4a";
  if (t.includes("ogg")) return "ogg";
  if (t.includes("wav")) return "wav";
  return "webm";
}

export function Recorder() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { addFromBlob } = useRecordings();
  const isOnline = useOnlineStatus();

  // Durable "save failed" state: keep the blob so the user can retry / download
  // instead of losing the recording (quota, private mode, IDB failure).
  const [saveFailed, setSaveFailed] = useState<CapturedAudio | null>(null);

  // Persist finalized audio for EVERY stop path (user, auto-stop, error-stop).
  const handleComplete = useCallback(
    async (captured: CapturedAudio) => {
      try {
        await addFromBlob(captured);
        setSaveFailed(null);
      } catch {
        // Don't drop the audio — surface a recoverable failure with the blob.
        setSaveFailed(captured);
      }
    },
    [addFromBlob],
  );

  const { isRecording, elapsedMs, error, isSupported, start, stop } =
    useRecorder(canvasRef, { onComplete: handleComplete });

  const retrySave = useCallback(async () => {
    if (!saveFailed) return;
    try {
      await addFromBlob(saveFailed);
      setSaveFailed(null);
    } catch {
      /* keep the failure state so the user can still download */
    }
  }, [saveFailed, addFromBlob]);

  const downloadFailed = useCallback(() => {
    if (!saveFailed) return;
    const url = URL.createObjectURL(saveFailed.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `recording-${Date.now()}.${extensionForMime(saveFailed.mimeType)}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [saveFailed]);

  if (!isSupported) {
    return (
      <section className="flex flex-col items-center gap-4 rounded-2xl border border-red-500/30 bg-[#0f172a] p-8 text-center">
        <span className="text-red-400">
          <WifiOffIcon width={28} height={28} />
        </span>
        <p className="text-sm text-slate-300">
          Audio recording isn't supported in this browser. Try a recent version
          of Chrome, Edge, Firefox, or Safari.
        </p>
      </section>
    );
  }

  return (
    <section className="flex flex-col items-center gap-6 py-6">
      {!isRecording ? (
        <div className="max-w-[290px] text-center">
          <h2 className="text-2xl font-bold tracking-tight">Tap to speak</h2>
          <p className="mt-2 text-sm leading-relaxed text-slate-500">
            {isOnline
              ? "We'll transcribe your recording right away — or start it from the list."
              : "No connection needed. We'll transcribe once you're online again."}
          </p>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 text-sm font-bold text-amber-400">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" />
            REC
          </div>
          <div className="font-mono text-5xl font-bold tabular-nums tracking-tight text-white">
            {formatTimer(elapsedMs)}
          </div>
        </>
      )}

      {/* Live waveform (shares the recorder's MediaStream). */}
      <div className="h-[120px] w-full">
        <canvas ref={canvasRef} className="h-full w-full" />
      </div>

      {/* Big circular mic/stop button — always enabled. */}
      <button
        type="button"
        onClick={isRecording ? () => void stop() : () => void start()}
        aria-label={isRecording ? "Stop recording" : "Start recording"}
        className={[
          "flex h-16 w-16 items-center justify-center rounded-full text-white shadow-lg transition-transform active:scale-95",
          isRecording
            ? "bg-red-500 shadow-red-500/40 hover:bg-red-500/90"
            : "bg-indigo-600 shadow-indigo-600/50 hover:bg-indigo-500",
        ].join(" ")}
      >
        {isRecording ? (
          <StopIcon width={28} height={28} />
        ) : (
          <MicIcon width={28} height={28} />
        )}
      </button>

      {/* Offline reassurance / online note. */}
      {isRecording ? (
        <div className="flex items-center gap-2 rounded-2xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm font-semibold text-[#fcd9a4]">
          <WifiOffIcon width={18} height={18} className="text-amber-400" />
          Saved locally — will transcribe when online
        </div>
      ) : !isOnline ? (
        <div className="flex max-w-[320px] items-start gap-3 rounded-2xl border border-amber-500/25 bg-amber-500/[0.08] px-4 py-3">
          <WifiOffIcon
            width={20}
            height={20}
            className="mt-0.5 shrink-0 text-amber-400"
          />
          <p className="text-[13px] leading-relaxed text-[#fcd9a4]">
            <b className="font-bold text-[#fde8c4]">
              You're offline — recording still works.
            </b>{" "}
            Everything is saved to this device and transcribes automatically the
            moment you're back online.
          </p>
        </div>
      ) : (
        <p className="max-w-[300px] text-center text-xs text-slate-600">
          Online — your recording will be transcribable immediately from the
          list.
        </p>
      )}

      {error && (
        <p className="max-w-[320px] text-center text-xs text-red-400">{error}</p>
      )}

      {/* Durable save-failure recovery — never silently drop the audio. */}
      {saveFailed && (
        <div className="flex max-w-[340px] flex-col items-center gap-3 rounded-2xl border border-red-500/35 bg-red-500/10 px-4 py-3 text-center">
          <p className="text-[13px] leading-relaxed text-red-200">
            Couldn't save this recording to your device. Your audio is still
            here — retry, or download it so you don't lose it.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void retrySave()}
              className="rounded-[10px] bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
            >
              Retry save
            </button>
            <button
              type="button"
              onClick={downloadFailed}
              className="inline-flex items-center gap-1.5 rounded-[10px] border border-[#334155] px-3 py-1.5 text-xs font-semibold text-slate-300 hover:border-slate-500"
            >
              <DownloadIcon width={13} height={13} />
              Download
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
