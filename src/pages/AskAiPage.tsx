/**
 * AskAiPage — hosts section 20's AskAiPanel with scope="all". Reads ?q= from
 * the URL (the palette's Ask handoff) and passes it down as the initial
 * question, submitted exactly once per distinct q.
 *
 * INTEGRATION POINT (section 20-T3): replace the placeholder with
 *   import { AskAiPanel } from "../components/session/AskAiPanel";
 *   <AskAiPanel scope="all" initialQuestion={q ?? undefined} />
 * (or call useAskAi.ask(q, "all") once per q if the panel's API is
 * imperative-only — reconcile at merge.)
 */
import { useSearchParams } from "react-router";
import { SparklesIcon } from "../components/icons";

export function AskAiPage() {
  const [params] = useSearchParams();
  const q = params.get("q");

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      {q && (
        <div className="rounded-2xl border border-indigo-500/35 bg-indigo-500/10 px-4 py-3 text-sm text-indigo-200">
          Question: “{q}”
        </div>
      )}
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-[#1e293b] bg-[#0f172a] px-6 py-12 text-center">
        <span className="text-slate-600">
          <SparklesIcon width={28} height={28} />
        </span>
        <p className="text-sm font-semibold text-slate-300">
          Ask AI arrives with the AI slice
        </p>
        <p className="max-w-sm text-[13px] leading-relaxed text-slate-500">
          Soon you'll get synthesized answers with citations from all your
          sessions. Your question above will auto-submit once the feature
          lands.
        </p>
      </div>
    </div>
  );
}
