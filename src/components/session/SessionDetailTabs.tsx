/**
 * SessionDetailTabs — role="tablist" hosting section 20's AI panes:
 * AI Summary (SummaryPanel), Follow-ups (FollowUpDraft), Ask (AskAiPanel
 * scope="session"). Arrow-key roving focus, aria-selected, tabpanels.
 *
 * INTEGRATION POINT (section 20-T3): swap the typed placeholders for
 *   import { SummaryPanel } from "./SummaryPanel";
 *   import { FollowUpDraft } from "./FollowUpDraft";
 *   import { AskAiPanel } from "./AskAiPanel";
 * All three take `sessionId` and are self-contained (own loading/offline/
 * error states) per 20-T3's contract.
 */
import { useRef, useState, type ComponentType } from "react";
import { SparklesIcon } from "../icons";

export type DetailTab = "summary" | "followups" | "ask";

interface PanelProps {
  sessionId: string;
}

function PlaceholderPanel({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-[#1e293b] bg-[#0f172a] px-6 py-12 text-center">
      <span className="text-slate-600">
        <SparklesIcon width={26} height={26} />
      </span>
      <p className="text-sm font-semibold text-slate-300">
        {label} arrives with the AI slice
      </p>
      <p className="max-w-xs text-[13px] leading-relaxed text-slate-500">
        AI features are being wired up. This tab will light up automatically
        once they land.
      </p>
    </div>
  );
}

const SummaryHost: ComponentType<PanelProps> = () => (
  <PlaceholderPanel label="AI Summary" />
);
const FollowUpsHost: ComponentType<PanelProps> = () => (
  <PlaceholderPanel label="Follow-up drafting" />
);
const AskHost: ComponentType<PanelProps> = () => (
  <PlaceholderPanel label="Ask AI" />
);

const TABS: { id: DetailTab; label: string }[] = [
  { id: "summary", label: "AI Summary" },
  { id: "followups", label: "Follow-ups" },
  { id: "ask", label: "Ask" },
];

export function SessionDetailTabs({
  sessionId,
  initialTab = "summary",
}: {
  sessionId: string;
  initialTab?: DetailTab;
}) {
  const [active, setActive] = useState<DetailTab>(initialTab);
  const tabRefs = useRef<Map<DetailTab, HTMLButtonElement>>(new Map());

  const onKeyDown = (e: React.KeyboardEvent) => {
    const idx = TABS.findIndex((t) => t.id === active);
    let next = -1;
    if (e.key === "ArrowRight") next = (idx + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (idx - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const id = TABS[next].id;
    setActive(id);
    tabRefs.current.get(id)?.focus();
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div
        role="tablist"
        aria-label="AI features"
        onKeyDown={onKeyDown}
        className="flex gap-1 border-b border-[#1e293b] px-1"
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            ref={(el) => {
              if (el) tabRefs.current.set(tab.id, el);
            }}
            role="tab"
            id={`tab-${tab.id}`}
            aria-selected={active === tab.id}
            aria-controls={`panel-${tab.id}`}
            tabIndex={active === tab.id ? 0 : -1}
            onClick={() => setActive(tab.id)}
            className={[
              "border-b-2 px-3.5 py-2.5 text-[13px] font-bold",
              active === tab.id
                ? "border-indigo-400 text-indigo-200"
                : "border-transparent text-slate-500 hover:text-slate-300",
            ].join(" ")}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-1 pb-6 pt-4">
        {TABS.map((tab) => (
          <div
            key={tab.id}
            role="tabpanel"
            id={`panel-${tab.id}`}
            aria-labelledby={`tab-${tab.id}`}
            hidden={active !== tab.id}
          >
            {active === tab.id &&
              (tab.id === "summary" ? (
                <SummaryHost sessionId={sessionId} />
              ) : tab.id === "followups" ? (
                <FollowUpsHost sessionId={sessionId} />
              ) : (
                <AskHost sessionId={sessionId} />
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}
