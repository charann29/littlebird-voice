/**
 * AskAiPanel — question input + streamed answer list with source-chip
 * citations (scope=all links each source to its session).
 *
 * Used in two places:
 * - SessionDetailTabs "Ask" tab: scope="session" + sessionId.
 * - AskAiPage (and the palette handoff): scope="all" + optional
 *   initialQuestion (auto-submitted once per distinct value).
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useAskAi, type AskEntry } from "../../hooks/useAskAi";
import { useOnlineStatus } from "../../hooks/useOnlineStatus";
import { AlertIcon, SparklesIcon, SpinnerIcon } from "../icons";
import type { AskScope } from "../../lib/ai-types";

function EntryCard({ entry }: { entry: AskEntry }) {
  return (
    <div className="flex flex-col gap-2.5 rounded-2xl border border-[#1e293b] bg-[#0f172a] px-4 py-3.5">
      <p className="text-[13px] font-bold text-indigo-200">{entry.question}</p>

      {entry.status === "error" ? (
        <div className="flex items-start gap-2 rounded-[11px] border border-red-500/30 bg-red-500/[.07] px-3 py-2.5">
          <span className="mt-0.5 shrink-0 text-red-400">
            <AlertIcon width={13} height={13} />
          </span>
          <p className="text-[12.5px] text-red-200">
            {entry.errorCode === "ai_unavailable"
              ? "The AI service is temporarily unavailable — try again shortly."
              : (entry.errorMessage ?? "Something went wrong.")}
          </p>
        </div>
      ) : (
        <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-slate-300">
          {entry.answer}
          {entry.status === "streaming" && (
            <span className="ml-1 inline-block h-3.5 w-[7px] animate-pulse bg-indigo-400 align-middle" />
          )}
        </p>
      )}

      {entry.sources.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-[#1e293b] pt-2.5">
          {entry.sources.map((s) => (
            <Link
              key={s.session_id}
              to={`/sessions/${s.session_id}`}
              title={s.snippet}
              className="max-w-[220px] truncate rounded-full border border-[#334155] bg-[#111a2e] px-2.5 py-1 text-[11px] font-bold text-slate-300 no-underline hover:border-indigo-500/60 hover:text-indigo-200"
            >
              {s.title || "Untitled session"}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function AskAiPanel({
  scope,
  sessionId,
  initialQuestion,
}: {
  scope: AskScope;
  /** Required when scope="session". */
  sessionId?: string;
  /** Auto-submitted once per distinct value (palette → /ask?q= handoff). */
  initialQuestion?: string;
}) {
  const online = useOnlineStatus();
  const { entries, streaming, ask } = useAskAi();
  const [question, setQuestion] = useState("");
  const listEndRef = useRef<HTMLDivElement | null>(null);
  const submittedInitial = useRef<string | null>(null);

  // Auto-submit the handed-off question exactly once per distinct q.
  useEffect(() => {
    const q = initialQuestion?.trim();
    if (!q || submittedInitial.current === q || !online) return;
    submittedInitial.current = q;
    ask(q, scope, sessionId);
  }, [initialQuestion, scope, sessionId, ask, online]);

  // Keep the newest answer in view while streaming.
  useEffect(() => {
    // Guarded: jsdom doesn't implement scrollIntoView.
    listEndRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [entries]);

  const submit = () => {
    const q = question.trim();
    if (!q || streaming || !online) return;
    setQuestion("");
    ask(q, scope, sessionId);
  };

  return (
    <div className="flex flex-col gap-3">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex items-center gap-2"
      >
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={
            scope === "session"
              ? "Ask about this session…"
              : "Ask across all your sessions…"
          }
          aria-label="Ask AI"
          disabled={!online}
          className="min-w-0 flex-1 rounded-[13px] border border-[#1e293b] bg-[#0f172a] px-3.5 py-2.5 text-[13px] text-slate-200 placeholder:text-slate-600 focus:border-indigo-500/60 focus:outline-none disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!online || streaming || !question.trim()}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-[11px] bg-indigo-600 px-3.5 py-2.5 text-[12.5px] font-bold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {streaming ? (
            <SpinnerIcon width={13} height={13} />
          ) : (
            <SparklesIcon width={13} height={13} />
          )}
          Ask
        </button>
      </form>

      {!online && (
        <p className="rounded-[13px] border border-[#1e293b] bg-[#111a2e] px-3.5 py-2.5 text-[12.5px] text-slate-500">
          You're offline — Ask AI needs a connection.
        </p>
      )}

      {entries.length === 0 && online && (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-[#1e293b] bg-[#0f172a] px-6 py-10 text-center">
          <span className="text-slate-600">
            <SparklesIcon width={24} height={24} />
          </span>
          <p className="text-sm font-semibold text-slate-300">
            {scope === "session"
              ? "Ask anything about this session"
              : "Ask anything across your sessions"}
          </p>
          <p className="max-w-xs text-[13px] text-slate-500">
            {scope === "session"
              ? "Answers come strictly from this transcript."
              : "Answers cite the sessions they came from."}
          </p>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {entries.map((e) => (
          <EntryCard key={e.id} entry={e} />
        ))}
        <div ref={listEndRef} />
      </div>
    </div>
  );
}
