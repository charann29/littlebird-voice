/**
 * FollowUpDraft — draft a grounded follow-up email/message from a session.
 *
 * - Format toggle (email/message) + optional instructions input ("keep it
 *   short, mention the deadline").
 * - "Which speaker is you?" picker: lists the session's diarized speaker
 *   labels and PATCHes `self_speaker` via section 10's PATCH
 *   /api/sessions/:id (optional — drafts are neutral without it).
 * - Streamed draft lands in an editable textarea; Copy stays the default
 *   terminal action. Section 40 adds opt-in send affordances: Gmail for
 *   email drafts, Slack for message drafts (tokens stay Worker-side).
 */
import { useEffect, useMemo, useState } from "react";
import { useFollowup } from "../../hooks/useFollowup";
import { useOnlineStatus } from "../../hooks/useOnlineStatus";
import { apiFetch } from "../../lib/api";
import {
  GmailSendControl,
  SlackPostControl,
} from "../integrations/IntegrationActions";
import {
  AlertIcon,
  CheckIcon,
  CopyIcon,
  SparklesIcon,
  SpinnerIcon,
} from "../icons";
import type { FollowupFormat } from "../../lib/ai-types";
import type { SessionDetailResponse } from "../../lib/api-types";

export function FollowUpDraft({ sessionId }: { sessionId: string }) {
  const online = useOnlineStatus();
  const { draft, setDraft, status, errorCode, errorMessage, generate } =
    useFollowup(sessionId);

  const [format, setFormat] = useState<FollowupFormat>("email");
  const [instructions, setInstructions] = useState("");
  const [copied, setCopied] = useState(false);

  // Session detail for the speaker picker (diarized labels + current mapping).
  const [speakers, setSpeakers] = useState<string[]>([]);
  const [selfSpeaker, setSelfSpeaker] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiFetch<SessionDetailResponse>(`/sessions/${sessionId}`)
      .then((res) => {
        if (cancelled || !res) return;
        const labels = new Set<string>();
        for (const s of res.segments) if (s.speaker) labels.add(s.speaker);
        setSpeakers(
          [...labels].sort((a, b) =>
            a.localeCompare(b, undefined, { numeric: true }),
          ),
        );
        setSelfSpeaker(res.session.self_speaker);
      })
      .catch(() => {
        /* offline / not synced — picker simply hidden */
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const pickSelfSpeaker = async (value: string | null) => {
    const prev = selfSpeaker;
    setSelfSpeaker(value);
    try {
      await apiFetch(`/sessions/${sessionId}`, {
        method: "PATCH",
        body: JSON.stringify({ self_speaker: value }),
      });
    } catch {
      setSelfSpeaker(prev); // revert on failure
    }
  };

  const copyDraft = async () => {
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const streaming = status === "streaming";
  const canGenerate = online && !streaming;

  const errorTitle = useMemo(() => {
    switch (errorCode) {
      case "transcript_not_ready":
        return "Transcript isn't ready yet";
      case "ai_unavailable":
        return "The AI service is temporarily unavailable";
      default:
        return "Couldn't draft the follow-up";
    }
  }, [errorCode]);

  if (!online && !draft) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-[#1e293b] bg-[#0f172a] px-6 py-12 text-center">
        <span className="text-slate-600">
          <SparklesIcon width={26} height={26} />
        </span>
        <p className="text-sm font-semibold text-slate-300">You're offline</p>
        <p className="max-w-xs text-[13px] text-slate-500">
          Follow-up drafting needs a connection.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* format toggle + generate */}
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="radiogroup"
          aria-label="Draft format"
          className="inline-flex rounded-full border border-[#1e293b] bg-[#0f172a] p-0.5"
        >
          {(["email", "message"] as const).map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={format === f}
              onClick={() => setFormat(f)}
              className={[
                "rounded-full px-3.5 py-1.5 text-[12.5px] font-bold capitalize",
                format === f
                  ? "bg-indigo-600 text-white"
                  : "text-slate-400 hover:text-slate-200",
              ].join(" ")}
            >
              {f}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => generate(format, instructions)}
          disabled={!canGenerate}
          className="inline-flex items-center gap-1.5 rounded-[11px] bg-indigo-600 px-3.5 py-2 text-[12.5px] font-bold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {streaming ? (
            <SpinnerIcon width={13} height={13} />
          ) : (
            <SparklesIcon width={13} height={13} />
          )}
          {streaming ? "Drafting…" : draft ? "Redraft" : "Draft follow-up"}
        </button>
      </div>

      {/* instructions */}
      <input
        type="text"
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        placeholder="Optional instructions — e.g. keep it short, mention the deadline"
        aria-label="Draft instructions"
        className="w-full rounded-[13px] border border-[#1e293b] bg-[#0f172a] px-3.5 py-2.5 text-[13px] text-slate-200 placeholder:text-slate-600 focus:border-indigo-500/60 focus:outline-none"
      />

      {/* self-speaker picker */}
      {speakers.length > 0 && (
        <div className="rounded-[13px] border border-[#1e293b] bg-[#111a2e] px-3.5 py-3">
          <p className="text-[11px] font-bold uppercase tracking-[.08em] text-slate-500">
            Which speaker is you?
          </p>
          <p className="mt-1 text-[12px] text-slate-500">
            Optional — lets the draft speak in first person for your own
            statements.
          </p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {speakers.map((sp) => (
              <button
                key={sp}
                type="button"
                aria-pressed={selfSpeaker === sp}
                onClick={() =>
                  void pickSelfSpeaker(selfSpeaker === sp ? null : sp)
                }
                className={[
                  "rounded-full border px-3 py-1 text-[12px] font-bold",
                  selfSpeaker === sp
                    ? "border-indigo-500 bg-indigo-500/15 text-indigo-200"
                    : "border-[#334155] bg-[#0f172a] text-slate-400 hover:text-slate-200",
                ].join(" ")}
              >
                Speaker {sp}
              </button>
            ))}
          </div>
        </div>
      )}

      {status === "error" && (
        <div className="flex items-start gap-2.5 rounded-2xl border border-red-500/30 bg-red-500/[.07] px-4 py-3.5">
          <span className="mt-0.5 shrink-0 text-red-400">
            <AlertIcon width={15} height={15} />
          </span>
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-red-200">
              {errorTitle}
            </p>
            <p className="mt-0.5 text-[12.5px] text-red-300/80">
              {errorMessage}
            </p>
          </div>
        </div>
      )}

      {/* draft area */}
      {(draft || streaming) && (
        <div className="flex flex-col gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            readOnly={streaming}
            rows={14}
            aria-label="Follow-up draft"
            className="w-full resize-y rounded-2xl border border-[#1e293b] bg-[#0f172a] px-4 py-3.5 font-sans text-[13.5px] leading-relaxed text-slate-200 focus:border-indigo-500/60 focus:outline-none"
          />
          <div className="flex items-center justify-between">
            <p className="text-[11.5px] text-slate-600">
              Edit freely — drafts aren't saved. Copy when you're happy with
              it.
            </p>
            <button
              type="button"
              onClick={() => void copyDraft()}
              disabled={streaming || !draft}
              className="inline-flex items-center gap-1.5 rounded-[11px] border border-[#1e293b] bg-[#0f172a] px-3 py-2 text-[12.5px] font-bold text-slate-300 hover:border-[#334155] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {copied ? (
                <CheckIcon width={13} height={13} />
              ) : (
                <CopyIcon width={13} height={13} />
              )}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>

          {/* section 40: opt-in send affordances (never automatic) */}
          {!streaming && draft && (
            <div className="flex flex-wrap gap-2">
              {format === "email" ? (
                <GmailSendControl body={draft} sessionId={sessionId} />
              ) : (
                <SlackPostControl text={draft} />
              )}
            </div>
          )}
        </div>
      )}

      {!draft && !streaming && status !== "error" && (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-[#1e293b] bg-[#0f172a] px-6 py-10 text-center">
          <span className="text-slate-600">
            <SparklesIcon width={24} height={24} />
          </span>
          <p className="text-sm font-semibold text-slate-300">
            Draft a follow-up from this session
          </p>
          <p className="max-w-xs text-[13px] text-slate-500">
            A grounded, professional {format} built from the summary and
            transcript. You edit and copy it — nothing is sent automatically.
          </p>
        </div>
      )}
    </div>
  );
}
