/**
 * StatusPill — canonical status enum pill (extracted from RecordingItem's
 * v1 pill; keeps the transcribing spinner). `done` + hasSummary reads
 * "Summarized" per the mockup.
 */
import type { SessionStatus } from "../../lib/api-types";
import type { TranscribeStage } from "../../types";
import { AlertIcon, CheckIcon, SpinnerIcon } from "../icons";

const STAGE_LABEL: Record<TranscribeStage, string> = {
  uploading: "Uploading…",
  creating: "Starting…",
  polling: "Transcribing…",
  fetching: "Finishing…",
};

export function StatusPill({
  status,
  stage,
  hasSummary = false,
}: {
  status: SessionStatus;
  stage?: TranscribeStage;
  hasSummary?: boolean;
}) {
  const base =
    "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-bold";
  switch (status) {
    case "pending":
      return (
        <span
          className={`${base} border-amber-500/30 bg-amber-500/15 text-amber-400`}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-current" />
          Pending
        </span>
      );
    case "transcribing":
      return (
        <span
          className={`${base} border-indigo-500/40 bg-indigo-500/15 text-indigo-200`}
        >
          <SpinnerIcon width={11} height={11} />
          {stage ? STAGE_LABEL[stage] : "Transcribing…"}
        </span>
      );
    case "done":
      return (
        <span
          className={`${base} border-green-500/30 bg-green-500/15 text-green-400`}
        >
          <CheckIcon width={10} height={10} />
          {hasSummary ? "Summarized" : "Done"}
        </span>
      );
    case "error":
      return (
        <span
          className={`${base} border-red-500/35 bg-red-500/15 text-red-300`}
        >
          <AlertIcon width={11} height={11} />
          Error
        </span>
      );
  }
}
