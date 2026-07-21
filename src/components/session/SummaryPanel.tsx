/**
 * SummaryPanel — renders the five SummaryV1 sections for a session:
 * Overview card, Action items (checklist rows with owner/due chips),
 * Decisions (green check rows), Key quotes (left-border blockquotes with
 * speaker attribution), Risks/open questions (red-tinted rows).
 *
 * Self-contained (per 20-T3's contract): owns loading/empty/generating/error
 * states and an offline-disabled state via useOnlineStatus. Regenerate is
 * disabled while a generation is in flight (long transcripts run 202+queued;
 * the hook polls until the new summary lands).
 */
import { useState } from "react";
import { useSummary } from "../../hooks/useSummary";
import { useOnlineStatus } from "../../hooks/useOnlineStatus";
import {
  AlertIcon,
  CheckIcon,
  RefreshIcon,
  SparklesIcon,
  SpinnerIcon,
} from "../icons";
import type { SummaryV1 } from "../../lib/ai-types";

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-bold uppercase tracking-[.08em] text-slate-500">
      {children}
    </h3>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="text-[13px] text-slate-600">{children}</p>;
}

function SummaryBody({ summary }: { summary: SummaryV1 }) {
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const toggle = (i: number) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  return (
    <div className="flex flex-col gap-5">
      {/* Overview */}
      <div className="rounded-2xl border border-[#1e293b] bg-[#0f172a] px-4 py-3.5">
        <SectionHeader>Overview</SectionHeader>
        <p className="mt-2 text-sm leading-relaxed text-slate-300">
          {summary.overview}
        </p>
      </div>

      {/* Action items */}
      <div className="flex flex-col gap-2">
        <SectionHeader>Action items</SectionHeader>
        {summary.action_items.length === 0 ? (
          <EmptyNote>No action items surfaced.</EmptyNote>
        ) : (
          summary.action_items.map((item, i) => (
            <label
              key={i}
              className="flex cursor-pointer items-start gap-3 rounded-[13px] border border-[#1e293b] bg-[#111a2e] px-3.5 py-2.5"
            >
              <input
                type="checkbox"
                checked={checked.has(i)}
                onChange={() => toggle(i)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-indigo-600"
              />
              <span className="min-w-0 flex-1">
                <span
                  className={[
                    "block text-[13.5px] leading-snug",
                    checked.has(i)
                      ? "text-slate-500 line-through"
                      : "text-slate-200",
                  ].join(" ")}
                >
                  {item.text}
                </span>
                {(item.owner || item.due) && (
                  <span className="mt-1.5 flex flex-wrap gap-1.5">
                    {item.owner && (
                      <span className="rounded-full border border-indigo-500/35 bg-indigo-500/10 px-2 py-0.5 text-[10.5px] font-bold text-indigo-300">
                        {item.owner}
                      </span>
                    )}
                    {item.due && (
                      <span className="rounded-full border border-amber-500/35 bg-amber-500/10 px-2 py-0.5 text-[10.5px] font-bold text-amber-300">
                        {item.due}
                      </span>
                    )}
                  </span>
                )}
              </span>
            </label>
          ))
        )}
      </div>

      {/* Decisions */}
      <div className="flex flex-col gap-2">
        <SectionHeader>Decisions</SectionHeader>
        {summary.decisions.length === 0 ? (
          <EmptyNote>No decisions recorded.</EmptyNote>
        ) : (
          summary.decisions.map((d, i) => (
            <div
              key={i}
              className="flex items-start gap-2.5 rounded-[13px] border border-[#1e293b] bg-[#0f172a] px-3.5 py-2.5"
            >
              <span className="mt-0.5 shrink-0 text-green-500">
                <CheckIcon width={14} height={14} />
              </span>
              <p className="text-[13.5px] leading-snug text-slate-300">{d}</p>
            </div>
          ))
        )}
      </div>

      {/* Key quotes */}
      <div className="flex flex-col gap-2">
        <SectionHeader>Key quotes</SectionHeader>
        {summary.key_quotes.length === 0 ? (
          <EmptyNote>No standout quotes.</EmptyNote>
        ) : (
          summary.key_quotes.map((q, i) => (
            <blockquote
              key={i}
              className="border-l-2 border-violet-600 pl-3.5 py-1"
            >
              <p className="text-[13.5px] italic leading-relaxed text-slate-300">
                “{q.quote}”
              </p>
              {q.speaker && (
                <footer className="mt-1 text-[11.5px] font-bold text-slate-500">
                  — Speaker {q.speaker}
                </footer>
              )}
            </blockquote>
          ))
        )}
      </div>

      {/* Risks / open questions */}
      <div className="flex flex-col gap-2">
        <SectionHeader>Risks &amp; open questions</SectionHeader>
        {summary.risks_open_questions.length === 0 ? (
          <EmptyNote>Nothing unresolved.</EmptyNote>
        ) : (
          summary.risks_open_questions.map((r, i) => (
            <div
              key={i}
              className="flex items-start gap-2.5 rounded-[13px] border border-red-500/25 bg-red-500/[.06] px-3.5 py-2.5"
            >
              <span className="mt-0.5 shrink-0 text-red-400">
                <AlertIcon width={14} height={14} />
              </span>
              <p className="text-[13.5px] leading-snug text-slate-300">{r}</p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function SummaryPanel({ sessionId }: { sessionId: string }) {
  const online = useOnlineStatus();
  const { summary, generatedAt, status, errorCode, errorMessage, generate } =
    useSummary(sessionId);

  const busy = status === "loading" || status === "generating";

  if (!online && !summary) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-[#1e293b] bg-[#0f172a] px-6 py-12 text-center">
        <span className="text-slate-600">
          <SparklesIcon width={26} height={26} />
        </span>
        <p className="text-sm font-semibold text-slate-300">You're offline</p>
        <p className="max-w-xs text-[13px] text-slate-500">
          AI summaries need a connection. This tab will work once you're back
          online.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 text-[11.5px] text-slate-500">
          {status === "generating"
            ? "Generating summary…"
            : generatedAt
              ? `Generated ${new Date(generatedAt).toLocaleString([], {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}`
              : summary
                ? `Model: ${summary.model}`
                : null}
        </div>
        <button
          type="button"
          onClick={generate}
          disabled={busy || !online}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-[11px] border border-[#1e293b] bg-[#0f172a] px-3 py-2 text-[12.5px] font-bold text-slate-300 hover:border-[#334155] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {status === "generating" ? (
            <SpinnerIcon width={13} height={13} />
          ) : (
            <RefreshIcon width={13} height={13} />
          )}
          {summary ? "Regenerate" : "Generate summary"}
        </button>
      </div>

      {status === "loading" && (
        <div className="flex items-center gap-2 rounded-2xl border border-[#1e293b] bg-[#0f172a] px-4 py-6 text-[13px] text-slate-500">
          <SpinnerIcon width={14} height={14} /> Loading summary…
        </div>
      )}

      {status === "error" && (
        <div className="flex items-start gap-2.5 rounded-2xl border border-red-500/30 bg-red-500/[.07] px-4 py-3.5">
          <span className="mt-0.5 shrink-0 text-red-400">
            <AlertIcon width={15} height={15} />
          </span>
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-red-200">
              {errorCode === "transcript_not_ready"
                ? "Transcript isn't ready yet"
                : errorCode === "ai_unavailable"
                  ? "The AI service is temporarily unavailable"
                  : errorCode === "timeout"
                    ? "Still working in the background"
                    : "Couldn't load the summary"}
            </p>
            <p className="mt-0.5 text-[12.5px] text-red-300/80">
              {errorMessage}
            </p>
          </div>
        </div>
      )}

      {status === "generating" && !summary && (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-[#1e293b] bg-[#0f172a] px-6 py-12 text-center">
          <span className="text-indigo-400">
            <SpinnerIcon width={24} height={24} />
          </span>
          <p className="text-sm font-semibold text-slate-300">
            Summarizing this session…
          </p>
          <p className="max-w-xs text-[13px] text-slate-500">
            Long transcripts run in the background — this can take a minute.
          </p>
        </div>
      )}

      {status === "idle" && (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-[#1e293b] bg-[#0f172a] px-6 py-12 text-center">
          <span className="text-slate-600">
            <SparklesIcon width={26} height={26} />
          </span>
          <p className="text-sm font-semibold text-slate-300">
            No summary yet
          </p>
          <p className="max-w-xs text-[13px] text-slate-500">
            Summaries are generated automatically when transcription finishes —
            or generate one now.
          </p>
        </div>
      )}

      {summary && status !== "loading" && <SummaryBody summary={summary} />}
    </div>
  );
}
