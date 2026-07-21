/**
 * Follow-up draft builder (section 20 T2): stored summary (generated first if
 * missing) + head/tail transcript excerpts + the session's `self_speaker`
 * mapping (neutral variant when null) → streamed draft. Nothing persisted —
 * drafts are deliberately ephemeral.
 */

import type { Env } from "../env";
import { headTailExcerpt } from "./chunking";
import { followupSystem, followupUserPrompt } from "./prompts";
import { getProvider } from "./provider";
import {
  generateSummary,
  loadOwnedSession,
  loadSegments,
  loadStoredSummary,
  SessionNotFoundError,
  TranscriptNotReadyError,
} from "./summarize";

export type FollowupFormat = "email" | "message";

export interface FollowupRequest {
  format: FollowupFormat;
  instructions?: string;
}

/**
 * Build the follow-up prompt and return the provider's delta stream.
 * Throws SessionNotFoundError / TranscriptNotReadyError / AiError before any
 * delta is emitted (routes map those to JSON errors).
 */
export async function streamFollowup(
  env: Env,
  userId: string,
  sessionId: string,
  req: FollowupRequest,
): Promise<ReadableStream<string>> {
  const session = await loadOwnedSession(env, userId, sessionId);
  if (!session) throw new SessionNotFoundError(sessionId);
  if (session.status !== "done") {
    throw new TranscriptNotReadyError(
      `Session status is '${session.status}', not 'done'`,
    );
  }
  const segments = await loadSegments(env, sessionId);
  if (segments.length === 0) {
    throw new TranscriptNotReadyError("Session has no transcript segments");
  }

  // Grounding summary: reuse the stored one, generate synchronously if absent.
  const stored = await loadStoredSummary(env, sessionId);
  const summary = stored?.payload ?? (await generateSummary(env, userId, sessionId));

  const provider = getProvider(env);
  return provider.stream({
    system: followupSystem(req.format, session.self_speaker),
    user: followupUserPrompt(summary, headTailExcerpt(segments), req.instructions),
  });
}
