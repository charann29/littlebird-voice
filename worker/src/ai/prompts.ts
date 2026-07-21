/**
 * Prompt templates for all section-20 LLM calls, kept as pure template
 * functions (plan: worker/src/ai/prompts.ts). Transcripts are rendered as
 * `[{speaker}] ({mm:ss}) {text}` lines by chunking.ts.
 */

import type { SummaryV1 } from "./types";

/** JSON schema for the model-produced summary sections (JSON mode). */
export const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    overview: { type: "string" },
    action_items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          owner: { type: ["string", "null"] },
          due: { type: ["string", "null"] },
        },
        required: ["text", "owner", "due"],
      },
    },
    decisions: { type: "array", items: { type: "string" } },
    key_quotes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          speaker: { type: ["string", "null"] },
          quote: { type: "string" },
        },
        required: ["speaker", "quote"],
      },
    },
    risks_open_questions: { type: "array", items: { type: "string" } },
  },
  required: [
    "overview",
    "action_items",
    "decisions",
    "key_quotes",
    "risks_open_questions",
  ],
} as const;

export const SUMMARIZE_SYSTEM =
  "You summarize meeting/voice-note transcripts. Output only valid JSON " +
  "matching the given schema. Overview: 2–4 sentences. Action items: " +
  "concrete tasks; set owner/due only if stated or clearly inferable, else " +
  "null. Decisions: things agreed or concluded. Key quotes: short verbatim " +
  "quotes (keep original language). Risks/open questions: unresolved " +
  "issues. Write in the transcript's dominant language. If a section has " +
  "nothing, use an empty array. Never invent content not in the transcript.";

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const m = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const s = String(totalSeconds % 60).padStart(2, "0");
  return `${m}:${s}`;
}

export function summarizeUserPrompt(
  title: string,
  durationMs: number,
  transcript: string,
): string {
  return `Session title: ${title}\nDuration: ${formatDuration(durationMs)}\nTranscript:\n${transcript}`;
}

/** Reduce step: merge partial summaries of consecutive segments. */
export function summarizeReducePrompt(partialsJson: string[]): string {
  return (
    "Partial summaries of consecutive segments of one meeting:\n" +
    partialsJson.join("\n") +
    "\nMerge into one summary. Deduplicate action items/decisions; keep the best quotes."
  );
}

export function followupSystem(
  format: "email" | "message",
  selfSpeaker: string | null,
): string {
  const voice = selfSpeaker
    ? `The user is speaker ${selfSpeaker}; treat that speaker's statements and commitments as the user's own.`
    : "It is unknown which speaker is the user; write neutrally on their behalf and do not guess.";
  const subject =
    format === "email" ? "include a Subject: line" : "no subject line";
  return (
    `You draft a clear, professional follow-up ${format} on behalf of the ` +
    `user who recorded this session. Write in first person. ${voice} ` +
    "Ground every claim in the summary/transcript; do not invent " +
    "commitments. Structure: brief thanks/context, key outcomes, action " +
    `items with owners, next step. Output only the draft (${subject}). No preamble.`
  );
}

export function followupUserPrompt(
  summary: SummaryV1,
  transcriptExcerpts: string,
  instructions: string | undefined,
): string {
  return (
    `Summary:\n${JSON.stringify(summary)}\n\n` +
    `Transcript excerpts:\n${transcriptExcerpts}\n\n` +
    `User instructions: ${instructions?.trim() || "none"}`
  );
}

export const ASK_SYSTEM =
  "Answer the question using ONLY the provided transcript context. Quote or " +
  "paraphrase with attribution (speaker, and session title when multiple " +
  "sessions are given). If the context does not contain the answer, say you " +
  "can't find it in the transcripts. Be concise.";

export function askSessionUserPrompt(
  transcript: string,
  question: string,
): string {
  return `Transcript:\n${transcript}\n\nQuestion: ${question}`;
}

/** Context passage hits already formatted as "— {title} ({date}):\n{text}". */
export function askAllUserPrompt(passages: string[], question: string): string {
  return (
    `Context passages from the user's sessions:\n${passages.join("\n")}\n\n` +
    `Question: ${question}`
  );
}

/** Map step for long single-session Ask: verbatim relevance extraction. */
export function relevanceExtractSystem(): string {
  return (
    "From this transcript segment, copy the lines relevant to the question, " +
    "verbatim with speaker labels. If nothing is relevant, output NONE."
  );
}

export function relevanceExtractUserPrompt(
  chunk: string,
  question: string,
): string {
  return `Question: ${question}\n\nTranscript segment:\n${chunk}`;
}

/** Repair suffix appended after a malformed-JSON model response. */
export const JSON_REPAIR_SUFFIX =
  "Your previous output was invalid JSON. Output only valid JSON for the schema.";
