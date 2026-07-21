/**
 * MeetingCapture — Meeting-mode capture screen (plan 40 Track A, T2).
 *
 * Exported screen component ONLY: section 50's shell mounts it at
 * /capture/meeting — this file does not touch App.tsx or any routing.
 *
 * UI follows docs/designs/v2/capture-meeting.html: a three-card source picker
 * (Mic only "Works offline" / Tab + Mic "Best for calls" / Screen + Mic with
 * the amber system-audio caveat), then a capture-in-progress view with a live
 * header (active-source pills, timer, "Stop & summarize"), per-channel level
 * meters, and the streaming transcript.
 *
 * Platform constraints surfaced in copy (hard browser limits, not bugs):
 * every session shows the browser share picker (no silent capture), a click
 * is always required, and tab/system audio is desktop-Chromium-only (system
 * audio Windows/ChromeOS-only) — unsupported modes render disabled with an
 * explanation from getCaptureSupport().
 */

import { useEffect, useRef, type ReactNode } from "react";
import { useMeetingCapture } from "../hooks/useMeetingCapture";
import {
  AlertIcon,
  CheckIcon,
  MicIcon,
  MonitorIcon,
  SparklesIcon,
  TabIcon,
} from "./icons";

function formatTimer(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const m = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const s = String(totalSeconds % 60).padStart(2, "0");
  return `${m}:${s}`;
}

/* ------------------------------------------------------------------ picker */

interface SourceCardProps {
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  icon: ReactNode;
  title: string;
  description: string;
  tag: ReactNode;
  /** Shown instead of the tag when the mode is unsupported. */
  disabledReason?: string;
  testId: string;
}

function SourceCard({
  selected,
  disabled,
  onSelect,
  icon,
  title,
  description,
  tag,
  disabledReason,
  testId,
}: SourceCardProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={selected}
      disabled={disabled}
      title={disabled ? disabledReason : undefined}
      onClick={onSelect}
      className={[
        "relative rounded-2xl border p-5 text-left transition-colors",
        disabled
          ? "cursor-not-allowed border-slate-800 bg-slate-900/50 opacity-55"
          : selected
            ? "border-indigo-600/60 bg-gradient-to-b from-indigo-600/15 to-slate-900"
            : "border-slate-800 bg-slate-900 hover:border-slate-600",
      ].join(" ")}
    >
      <span
        aria-hidden="true"
        className={[
          "absolute top-3.5 right-3.5 flex h-5 w-5 items-center justify-center rounded-full border-[1.5px]",
          selected
            ? "border-indigo-600 bg-indigo-600 text-white"
            : "border-slate-600 text-transparent",
        ].join(" ")}
      >
        <CheckIcon className="h-3 w-3" strokeWidth={3.5} />
      </span>
      <span
        className={[
          "mb-3.5 flex h-11 w-11 items-center justify-center rounded-xl border",
          selected
            ? "border-indigo-600/40 bg-indigo-600/20 text-indigo-200"
            : "border-slate-800 bg-slate-800/60 text-slate-400",
        ].join(" ")}
      >
        {icon}
      </span>
      <span className="block text-[15px] font-bold text-white">{title}</span>
      <span className="mt-1 block text-[12.5px] leading-relaxed text-slate-400">
        {description}
      </span>
      {disabled && disabledReason ? (
        <span className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-800/60 px-2.5 py-1 text-[11px] font-bold text-slate-500">
          <AlertIcon className="h-2.5 w-2.5" />
          {disabledReason}
        </span>
      ) : (
        tag
      )}
    </button>
  );
}

/* ---------------------------------------------------------------- live view */

/** Per-channel level meter: 20 bars lit by the polled RMS level (0..1). */
const METER_BARS = 20;

function LevelMeter({
  level,
  color,
}: {
  level: number;
  color: "green" | "indigo";
}) {
  // Perceptual boost so quiet speech still moves the meter.
  const lit = Math.round(Math.min(1, Math.sqrt(level) * 1.6) * METER_BARS);
  return (
    <div
      className="mt-2.5 flex h-9 items-center gap-[3px]"
      role="meter"
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={Math.round(level * 100) / 100}
    >
      {Array.from({ length: METER_BARS }, (_, i) => (
        <span
          key={i}
          className={[
            "flex-1 rounded-[2px] transition-transform duration-100",
            i < lit
              ? color === "indigo"
                ? "bg-gradient-to-b from-indigo-400 to-indigo-600"
                : "bg-gradient-to-b from-green-400 to-green-500"
              : "bg-slate-800",
          ].join(" ")}
          style={{ height: `${35 + ((i * 37) % 60)}%` }}
        />
      ))}
    </div>
  );
}

function SourcePill({
  live,
  icon,
  label,
}: {
  live: boolean;
  icon: ReactNode;
  label: string;
}) {
  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-bold",
        live
          ? "border-green-500/35 bg-green-500/10 text-green-400"
          : "border-slate-700 bg-slate-800/60 text-slate-500",
      ].join(" ")}
    >
      {icon}
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------ screen */

export function MeetingCapture() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const capture = useMeetingCapture(canvasRef);
  const {
    mode,
    setMode,
    state,
    levels,
    activeSources,
    warning,
    error,
    start,
    stop,
    elapsedMs,
    finalText,
    interimText,
    support,
  } = capture;

  const isLive = state === "live" || state === "stopping";
  const tabDisabledReason = !support.tabAudio
    ? "Tab audio capture needs desktop Chrome or Edge."
    : undefined;
  const screenDisabledReason = !support.tabAudio
    ? "Screen audio capture needs desktop Chrome or Edge."
    : undefined;

  // Keep the transcript pinned to the newest text while streaming.
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [finalText, interimText]);

  return (
    <div className="flex w-full flex-col" data-testid="meeting-capture">
      {!isLive ? (
        /* ------------------------------------------------ source picker -- */
        <>
          <div className="mt-1 mb-3 text-[11px] font-bold tracking-[0.08em] text-slate-500 uppercase">
            Audio sources
          </div>

          <div className="grid gap-3.5 sm:grid-cols-3" data-testid="source-cards">
            <SourceCard
              testId="source-card-mic-only"
              selected={mode === "mic"}
              disabled={false}
              onSelect={() => setMode("mic")}
              icon={<MicIcon className="h-5 w-5" />}
              title="Mic only"
              description="Just your microphone — in-person meetings, voice notes, and dictation."
              tag={
                <span className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-green-500/30 bg-green-500/10 px-2.5 py-1 text-[11px] font-bold text-green-400">
                  <CheckIcon className="h-2.5 w-2.5" strokeWidth={3} />
                  Works offline
                </span>
              }
            />
            <SourceCard
              testId="source-card-tab-mic"
              selected={mode === "tab"}
              disabled={!support.tabAudio}
              disabledReason={tabDisabledReason}
              onSelect={() => setMode("tab")}
              icon={<TabIcon className="h-5 w-5" />}
              title="Tab + Mic"
              description="Mix a browser tab (Meet, Zoom web, a video) with your mic. Both sides of the call, diarized."
              tag={
                <span className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-indigo-600/40 bg-indigo-600/15 px-2.5 py-1 text-[11px] font-bold text-indigo-200">
                  <SparklesIcon className="h-2.5 w-2.5" />
                  Best for calls
                </span>
              }
            />
            <SourceCard
              testId="source-card-screen-mic"
              selected={mode === "screen"}
              disabled={!support.tabAudio}
              disabledReason={screenDisabledReason}
              onSelect={() => setMode("screen")}
              icon={<MonitorIcon className="h-5 w-5" />}
              title="Screen + Mic"
              description="Capture any app's audio via screen share — desktop Zoom, Teams, or Slack huddles."
              tag={
                <span className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] font-bold text-amber-400">
                  <AlertIcon className="h-2.5 w-2.5" strokeWidth={2.5} />
                  See note below
                </span>
              }
            />
          </div>

          {/* System-audio caveat (hard platform constraint). */}
          <div
            className="mt-3.5 flex items-start gap-2.5 rounded-2xl border border-amber-500/30 bg-amber-500/[0.08] px-3.5 py-3 text-[12.5px] leading-relaxed text-amber-400"
            data-testid="system-audio-caveat"
          >
            <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <b className="font-bold">Screen + Mic:</b> system-audio capture
              depends on your OS and browser. Chrome on Windows can share full
              system audio; on macOS, Chrome only shares audio from a tab or
              window that provides it — choose <b className="font-bold">Tab +
              Mic</b> for browser calls, and tick "Share audio" in the share
              dialog.
            </span>
          </div>

          {/* Per-session share prompt + echo/headphones hints. */}
          {mode !== "mic" && (
            <p className="mt-3 text-[12.5px] leading-relaxed text-slate-500">
              The browser will ask you to pick what to share every session —
              there's no way to skip that prompt.{" "}
              {mode === "tab"
                ? "Choose a Chrome Tab and tick “Also share tab audio”."
                : "Choose a screen or window, and enable audio sharing where offered."}{" "}
              Use headphones so your mic doesn't re-capture the call audio.
            </p>
          )}

          {error && (
            <p
              className="mt-3 text-sm font-medium text-red-400"
              data-testid="capture-error"
              role="alert"
            >
              {error}
            </p>
          )}

          <div className="mt-5 flex items-center gap-3.5">
            <button
              type="button"
              data-testid="start-capture-button"
              onClick={() => void start()}
              disabled={state !== "idle"}
              className="inline-flex items-center gap-2 rounded-2xl bg-gradient-to-b from-indigo-500 to-indigo-600 px-6 py-3 text-[14.5px] font-bold text-white shadow-lg shadow-indigo-600/40 transition-transform hover:from-indigo-400 active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <MicIcon className="h-4 w-4" />
              {state === "acquiring" ? "Waiting for permission…" : "Start capture"}
            </button>
            <span className="text-[12.5px] text-slate-500">
              Audio stays on this device until you choose to summarize.
            </span>
          </div>
        </>
      ) : (
        /* ------------------------------------------------- live capture -- */
        <>
          <div
            className="flex items-center gap-3.5 rounded-2xl border border-slate-800 bg-slate-900 px-4 py-4"
            data-testid="capture-live-header"
          >
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-green-500/40 bg-green-500/15 text-green-400">
              <MicIcon className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-bold text-white">
                {state === "stopping" ? "Finishing up…" : "Capturing meeting"}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                {mode !== "mic" && (
                  <SourcePill
                    live={activeSources.display}
                    icon={
                      mode === "screen" ? (
                        <MonitorIcon className="h-2.5 w-2.5" />
                      ) : (
                        <TabIcon className="h-2.5 w-2.5" />
                      )
                    }
                    label={mode === "screen" ? "Screen audio" : "Tab audio"}
                  />
                )}
                <SourcePill
                  live={activeSources.mic}
                  icon={<MicIcon className="h-2.5 w-2.5" />}
                  label="Mic"
                />
                <span>Diarized · saved on this device</span>
              </div>
            </div>
            <span
              className="text-[22px] font-bold tabular-nums text-green-400"
              data-testid="capture-timer"
            >
              {formatTimer(elapsedMs)}
            </span>
            <button
              type="button"
              data-testid="stop-and-summarize-button"
              onClick={() => void stop()}
              disabled={state === "stopping"}
              className="inline-flex items-center gap-2 rounded-xl border border-red-500/45 bg-red-500/15 px-4 py-3 text-[13.5px] font-bold text-red-300 transition-colors hover:bg-red-500/25 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span className="h-[11px] w-[11px] rounded-[2.5px] bg-red-500" />
              {state === "stopping" ? "Stopping…" : "Stop & summarize"}
            </button>
          </div>

          {warning && (
            <div
              className="mt-3 flex items-start gap-2.5 rounded-2xl border border-amber-500/30 bg-amber-500/[0.08] px-3.5 py-3 text-[12.5px] leading-relaxed text-amber-400"
              data-testid="capture-warning"
              role="status"
            >
              <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{warning}</span>
            </div>
          )}

          {/* Per-channel mixer meters. */}
          <div
            className={[
              "mt-3.5 grid gap-3.5",
              mode !== "mic" ? "sm:grid-cols-2" : "",
            ].join(" ")}
            data-testid="capture-mixer"
          >
            {mode !== "mic" && (
              <div
                className="rounded-2xl border border-slate-800 bg-slate-900 px-4 py-3"
                data-testid="mixer-display-channel"
              >
                <div className="flex items-center gap-2 text-xs font-bold text-slate-400">
                  {mode === "screen" ? (
                    <MonitorIcon className="h-3.5 w-3.5" />
                  ) : (
                    <TabIcon className="h-3.5 w-3.5" />
                  )}
                  {mode === "screen" ? "Screen audio" : "Tab audio"}
                  <span className="ml-auto text-[11px] font-semibold tabular-nums text-slate-600">
                    {activeSources.display && levels.display !== null
                      ? `${Math.round(levels.display * 100)}%`
                      : "off"}
                  </span>
                </div>
                <LevelMeter level={levels.display ?? 0} color="indigo" />
              </div>
            )}
            <div
              className="rounded-2xl border border-slate-800 bg-slate-900 px-4 py-3"
              data-testid="mixer-mic-channel"
            >
              <div className="flex items-center gap-2 text-xs font-bold text-slate-400">
                <MicIcon className="h-3.5 w-3.5" />
                Your mic
                <span className="ml-auto text-[11px] font-semibold tabular-nums text-slate-600">
                  {activeSources.mic ? `${Math.round(levels.mic * 100)}%` : "off"}
                </span>
              </div>
              <LevelMeter level={levels.mic} color="green" />
            </div>
          </div>

          {/* Shared waveform canvas (mixed stream), same viz as v1 paths. */}
          <canvas ref={canvasRef} className="mt-3 h-12 w-full" />

          {/* Streaming transcript. */}
          <div className="mt-4 mb-2.5 flex items-center justify-between">
            <h3 className="text-[11px] font-bold tracking-[0.08em] text-slate-500 uppercase">
              Live transcript
            </h3>
            <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-green-400">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-green-500" />
              Streaming · diarized
            </span>
          </div>
          <div
            ref={transcriptRef}
            className="max-h-[320px] overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900 px-5 py-4"
            data-testid="streaming-transcript"
            aria-live="polite"
          >
            {finalText || interimText ? (
              <p className="text-sm leading-relaxed text-slate-300">
                {finalText}
                {interimText && (
                  <span className="text-slate-500 italic"> {interimText}</span>
                )}
              </p>
            ) : (
              <p className="text-sm text-slate-600">
                {state === "stopping"
                  ? "Wrapping up the last words…"
                  : "Words from your mic and the shared audio will stream here."}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default MeetingCapture;
