/**
 * Section 20 public surface. Section 30's queue dispatcher imports
 * `handleTranscriptAutoSummary` from here (or directly from ./summarize).
 */

export {
  generateSummary,
  handleTranscriptAutoSummary,
  loadOwnedSession,
  loadSegments,
  loadStoredSummary,
  MEETING_SUMMARY_KIND,
  SessionNotFoundError,
  TranscriptNotReadyError,
  type GenerateSummaryOptions,
  type SegmentRow,
  type SummarizeQueueMessage,
} from "./summarize";
export { estimateChunkCount } from "./chunking";
export { AiError, getProvider, type LlmProvider } from "./provider";
export type { SummaryV1, SummaryContent } from "./types";
