import { useEffect, useRef, useState } from "react";
import { useSoniox } from "../hooks/useSoniox";
import { MicIcon, StopIcon, CopyIcon, CheckIcon, WifiOffIcon } from "./icons";

const MAX_CHARS = 8000;

const LANGS = [
  { label: "English", sub: null },
  { label: "हिन्दी", sub: "Hindi" },
  { label: "తెలుగు", sub: "Telugu" },
];

function formatTimer(seconds: number): string {
  const m = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const s = (seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

interface LiveTranscriptionProps {
  /** From useOnlineStatus — a UI hint. When false, live capture is disabled. */
  online: boolean;
}

/**
 * Online live-transcription view. Streams finalized tokens into an editable,
 * copyable transcript textarea, shows live interim text and an animated
 * waveform, and drives the big mic button (idle indigo → connecting yellow →
 * listening green, hover red to stop). When offline, the mic is disabled and a
 * steer banner points the user at the offline Recorder.
 */
export function LiveTranscription({ online }: LiveTranscriptionProps) {
  const [transcript, setTranscript] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [copied, setCopied] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const soniox = useSoniox((text) => {
    setTranscript((prev) => {
      const prefix = prev.length > 0 && !prev.endsWith(" ") ? " " : "";
      return prev + prefix + text;
    });
  }, canvasRef);

  const { isRecording, isConnecting } = soniox;
  const isActive = isRecording || isConnecting;

  // auto-grow the transcript textarea to fit content
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 320) + "px";
  }, [transcript, soniox.interimText]);

  // listening timer
  useEffect(() => {
    if (!isRecording) {
      setElapsed(0);
      return;
    }
    const id = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => window.clearInterval(id);
  }, [isRecording]);

  async function handleCopy() {
    const text = transcript.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked — no-op, keep the UI responsive
    }
  }

  return (
    <div className="flex w-full flex-col">
      {/* language chips */}
      <div className="flex flex-wrap gap-2 py-2">
        {LANGS.map((lang, i) => (
          <span
            key={lang.label}
            className={[
              "inline-flex items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-semibold",
              i === 0
                ? "border-indigo-600/55 bg-indigo-600/15 text-indigo-200"
                : "border-slate-700 bg-slate-900 text-slate-400",
            ].join(" ")}
          >
            {lang.label}
            {lang.sub && (
              <span className={i === 0 ? "text-indigo-300" : "text-slate-600"}>
                {lang.sub}
              </span>
            )}
          </span>
        ))}
      </div>

      {/* offline steer banner */}
      {!online && (
        <div className="mt-2 flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-400">
          <WifiOffIcon className="mt-0.5 h-5 w-5 shrink-0" />
          <p>
            Live transcription needs a connection — switch to the Recorder to
            capture offline.
          </p>
        </div>
      )}

      {soniox.micError && (
        <p className="mt-2 text-center text-sm text-red-400">
          {soniox.micError}
        </p>
      )}

      {/* transcript card */}
      <div
        className={[
          "mt-3 flex flex-1 flex-col gap-3 rounded-2xl border-2 bg-slate-900 p-4 transition-all duration-200",
          isConnecting
            ? "border-yellow-500/60 shadow-[0_0_30px_rgba(234,179,8,0.12)]"
            : isRecording
              ? "border-green-500/55 shadow-[0_0_30px_rgba(34,197,94,0.12)]"
              : "border-slate-700 focus-within:border-slate-500",
        ].join(" ")}
      >
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-bold tracking-[0.08em] text-slate-500 uppercase">
            Live transcript
          </span>
          <button
            onClick={handleCopy}
            disabled={!transcript.trim()}
            aria-label="Copy transcript"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:border-slate-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {copied ? (
              <CheckIcon className="h-3.5 w-3.5 text-green-400" />
            ) : (
              <CopyIcon className="h-3.5 w-3.5" />
            )}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>

        <textarea
          ref={textareaRef}
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
          maxLength={MAX_CHARS}
          rows={3}
          placeholder={
            isRecording
              ? "Listening…"
              : "Your words appear here live. Tap the mic to start, or type to edit."
          }
          className="max-h-[320px] min-h-[80px] w-full resize-none border-0 bg-transparent text-base leading-relaxed text-white placeholder-slate-600 outline-none"
        />

        {/* live interim text */}
        {isRecording && soniox.interimText && (
          <p className="px-0.5 text-base leading-relaxed text-slate-400 italic">
            {soniox.interimText}
          </p>
        )}

        {/* waveform — visible only while mic is active */}
        {isActive && <canvas ref={canvasRef} className="h-16 w-full" />}
      </div>

      {/* listening indicator + timer */}
      {isRecording && (
        <div className="mt-3 flex items-center justify-center gap-2 text-sm font-semibold text-green-400">
          <span className="h-2 w-2 animate-pulse rounded-full bg-green-500" />
          Listening&nbsp;·&nbsp;
          <span className="tabular-nums text-slate-400">
            {formatTimer(elapsed)}
          </span>
        </div>
      )}
      {isConnecting && (
        <div className="mt-3 flex items-center justify-center gap-2 text-sm font-semibold text-yellow-400">
          <span className="h-2 w-2 animate-pulse rounded-full bg-yellow-500" />
          Connecting…
        </div>
      )}

      {/* controls */}
      <div className="flex flex-col items-center gap-2 pt-6">
        <button
          onClick={soniox.toggleRecording}
          disabled={isConnecting || !online}
          aria-label={isRecording ? "Stop recording" : "Start recording"}
          className={[
            "flex h-16 w-16 shrink-0 items-center justify-center rounded-full shadow-lg transition-all duration-200 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50",
            isConnecting
              ? "bg-yellow-500 text-white"
              : isRecording
                ? "bg-green-500 text-white hover:bg-red-500"
                : "bg-indigo-600 text-white hover:bg-indigo-500",
          ].join(" ")}
        >
          {isRecording ? (
            <StopIcon className="h-6 w-6" />
          ) : (
            <MicIcon className="h-7 w-7" />
          )}
        </button>
        <p className="text-xs font-medium text-slate-600">
          {!online
            ? "Offline — live transcription unavailable"
            : isRecording
              ? "Tap to stop"
              : isConnecting
                ? "Connecting…"
                : "Press the mic to start"}
        </p>
      </div>
    </div>
  );
}
