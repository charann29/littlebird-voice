/**
 * AskAiPage — hosts section 20's AskAiPanel with scope="all". Reads ?q= from
 * the URL (the palette's Ask handoff) and passes it down as the initial
 * question; the panel submits it exactly once per distinct q.
 */
import { useSearchParams } from "react-router";
import { AskAiPanel } from "../components/session/AskAiPanel";

export function AskAiPage() {
  const [params] = useSearchParams();
  const q = params.get("q");

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <AskAiPanel scope="all" initialQuestion={q ?? undefined} />
    </div>
  );
}
