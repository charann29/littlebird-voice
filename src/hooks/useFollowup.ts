/**
 * useFollowup(sessionId) — SSE-streamed ephemeral follow-up draft.
 *
 * `generate(format, instructions?)` POSTs /sessions/:id/followup and streams
 * deltas into `draft`; the user then edits `draft` locally via `setDraft`
 * (nothing is persisted server-side). States: idle → streaming → ready |
 * error(code).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { postSse } from "../lib/sse";
import type { FollowupFormat } from "../lib/ai-types";

export type FollowupStatus = "idle" | "streaming" | "ready" | "error";

export interface UseFollowupResult {
  draft: string;
  setDraft: (text: string) => void;
  status: FollowupStatus;
  errorCode: string | null;
  errorMessage: string | null;
  generate: (format: FollowupFormat, instructions?: string) => void;
}

export function useFollowup(sessionId: string): UseFollowupResult {
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<FollowupStatus>("idle");
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Cancel any in-flight stream on unmount / session change.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, [sessionId]);

  const generate = useCallback(
    (format: FollowupFormat, instructions?: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setDraft("");
      setErrorCode(null);
      setErrorMessage(null);
      setStatus("streaming");

      void postSse(
        `/sessions/${sessionId}/followup`,
        instructions?.trim()
          ? { format, instructions: instructions.trim() }
          : { format },
        {
          onDelta: (text) => setDraft((d) => d + text),
          onDone: () => setStatus("ready"),
          onError: (code, message) => {
            setErrorCode(code);
            setErrorMessage(message);
            setStatus("error");
          },
        },
        { signal: controller.signal },
      );
    },
    [sessionId],
  );

  return { draft, setDraft, status, errorCode, errorMessage, generate };
}
