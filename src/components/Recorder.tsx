/**
 * Recorder — offline-capable recording UI.
 *
 * The record button is NEVER gated on connectivity: capturing audio is fully
 * local, and that offline-first capability is the whole point of the product.
 * When offline we reassure the user their audio is saved and will transcribe
 * automatically once back online; when online we note it can be transcribed
 * immediately from the list.
 */

import { useRef } from "react";
import { MicIcon, StopIcon, WifiOffIcon } from "./icons";
import { useRecorder } from "../hooks/useRecorder";
import { useRecordings } from "../hooks/useRecordings";
import { useOnlineStatus } from "../hooks/useOnlineStatus";

function formatTimer(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function Recorder() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { isRecording, elapsedMs, error, isSupported, start, stop } =
    useRecorder(canvasRef);
  const { addFromBlob } = useRecordings();
  const isOnline = useOnlineStatus();

  const handleStop = async () => {
    const captured = await stop();
    if (captured) {
      await addFromBlob(captured);
    }
  };

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
        onClick={isRecording ? handleStop : start}
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
    </section>
  );
}
