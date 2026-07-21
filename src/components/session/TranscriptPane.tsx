/**
 * TranscriptPane — diarized segment list (speaker chip + mm:ss + text).
 *
 * Segment source precedence: local Recording.segments → server
 * transcript_segments → single unlabelled block from local transcript →
 * status-appropriate empty state. Copy copies "Speaker N: text" lines.
 * Accepts highlight ({ start_ms }) from router location state (palette
 * handoff) and scrolls the matching segment into view.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Recording, TranscriptSegment } from "../../types";
import type { Segment, SessionStatus } from "../../lib/api-types";
import { CheckIcon, CopyIcon, RefreshIcon } from "../icons";

export interface DisplaySegment {
  speaker: string | null;
  start_ms: number | null;
  text: string;
}

const SPEAKER_COLORS = ["#4f46e5", "#0e7490", "#7c3aed", "#475569", "#b45309"];

function speakerColor(speaker: string | null): string {
  if (!speaker) return "#475569";
  const n = Number.parseInt(speaker, 10);
  return SPEAKER_COLORS[
    (Number.isNaN(n) ? speaker.charCodeAt(0) : n) % SPEAKER_COLORS.length
  ];
}

function formatMs(ms: number | null): string {
  if (ms === null) return "";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Pick display segments per the precedence rule (pure, unit-tested). */
export function resolveSegments(
  local: Recording | null,
  serverSegments: Segment[] | null,
): DisplaySegment[] | null {
  if (local?.segments && local.segments.length > 0) {
    return local.segments.map((s: TranscriptSegment) => ({
      speaker: s.speaker,
      start_ms: s.start_ms,
      text: s.text,
    }));
  }
  if (serverSegments && serverSegments.length > 0) {
    return serverSegments.map((s) => ({
      speaker: s.speaker,
      start_ms: s.start_ms,
      text: s.text,
    }));
  }
  if (local?.transcript) {
    return [{ speaker: null, start_ms: null, text: local.transcript }];
  }
  return null;
}

/** Plain-text export: "Speaker N: text" lines. */
export function segmentsToPlainText(segments: DisplaySegment[]): string {
  return segments
    .map((s) => (s.speaker ? `Speaker ${s.speaker}: ${s.text}` : s.text))
    .join("\n");
}

export function TranscriptPane({
  segments,
  status,
  error,
  highlight,
  onRetry,
}: {
  segments: DisplaySegment[] | null;
  status: SessionStatus;
  error?: string | null;
  highlight?: { start_ms: number } | null;
  onRetry?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const highlightRef = useRef<HTMLDivElement | null>(null);
  const [flash, setFlash] = useState(false);

  // Find the segment matching the highlight start_ms (nearest at-or-before).
  const highlightIndex = useMemo(() => {
    if (!highlight || !segments) return -1;
    let best = -1;
    for (let i = 0; i < segments.length; i++) {
      const start = segments[i].start_ms;
      if (start !== null && start <= highlight.start_ms) best = i;
    }
    return best;
  }, [highlight, segments]);

  useEffect(() => {
    if (highlightIndex < 0) return;
    highlightRef.current?.scrollIntoView({ block: "center" });
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 2500);
    return () => clearTimeout(t);
  }, [highlightIndex]);

  const copy = async () => {
    if (!segments) return;
    try {
      await navigator.clipboard.writeText(segmentsToPlainText(segments));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2.5 border-b border-[#1e293b] px-1 pb-3">
        <h2 className="text-[11px] font-bold uppercase tracking-[.08em] text-slate-500">
          Transcript
        </h2>
        {segments && (
          <button
            type="button"
            onClick={() => void copy()}
            className="ml-auto inline-flex items-center gap-1.5 rounded-[9px] border border-[#1e293b] px-2.5 py-1.5 text-[11.5px] font-semibold text-slate-400 hover:border-indigo-500/40 hover:text-indigo-200"
          >
            {copied ? (
              <CheckIcon width={12} height={12} />
            ) : (
              <CopyIcon width={12} height={12} />
            )}
            {copied ? "Copied" : "Copy transcript"}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-1 pb-6 pt-4">
        {segments ? (
          segments.map((seg, i) => (
            <div
              key={i}
              ref={i === highlightIndex ? highlightRef : undefined}
              className="mb-4 flex gap-3 last:mb-0"
            >
              {seg.speaker !== null && (
                <span
                  className="mt-px flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-extrabold text-white"
                  style={{ background: speakerColor(seg.speaker) }}
                >
                  S{seg.speaker}
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  {seg.speaker !== null && (
                    <span className="text-[12.5px] font-bold text-white">
                      Speaker {seg.speaker}
                    </span>
                  )}
                  {seg.start_ms !== null && (
                    <span className="text-[11px] tabular-nums text-slate-600">
                      {formatMs(seg.start_ms)}
                    </span>
                  )}
                </div>
                <p
                  className={[
                    "mt-0.5 text-[13.5px] leading-[1.65] text-slate-300",
                    i === highlightIndex && flash
                      ? "rounded-[10px] border border-indigo-500/30 bg-indigo-500/10 px-2.5 py-2"
                      : "",
                  ].join(" ")}
                >
                  {seg.text}
                </p>
              </div>
            </div>
          ))
        ) : status === "transcribing" ? (
          <p className="py-8 text-center text-sm text-slate-500">
            Transcribing…
          </p>
        ) : status === "pending" ? (
          <p className="py-8 text-center text-sm text-slate-500">
            Pending — will transcribe when online.
          </p>
        ) : status === "error" ? (
          <div className="flex flex-col items-center gap-3 py-8">
            <p className="text-sm text-red-300/90">
              {error || "Transcription failed."}
            </p>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex items-center gap-1.5 rounded-[10px] border border-red-500/35 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-300 hover:bg-red-500/15"
              >
                <RefreshIcon width={13} height={13} />
                Retry
              </button>
            )}
          </div>
        ) : (
          <p className="py-8 text-center text-sm text-slate-500">
            No transcript available.
          </p>
        )}
      </div>
    </div>
  );
}
