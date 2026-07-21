/**
 * useAskAi() — local Q&A history over POST /api/ask (SSE-streamed answers).
 *
 * Single question → single answer per call (no multi-turn memory); the hook
 * keeps a display-only history of entries with per-entry streamed text and
 * `sources` citations (scope=all). This is the data hook the command palette
 * and AskAiPage call — its types are exported from here.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { postSse } from "../lib/sse";
import type { AskScope, AskSource } from "../lib/ai-types";

export type { AskScope, AskSource };

export type AskEntryStatus = "streaming" | "done" | "error";

export interface AskEntry {
  id: number;
  question: string;
  scope: AskScope;
  sessionId?: string;
  answer: string;
  sources: AskSource[];
  status: AskEntryStatus;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface UseAskAiResult {
  entries: AskEntry[];
  /** True while any entry is streaming. */
  streaming: boolean;
  ask: (question: string, scope: AskScope, sessionId?: string) => void;
}

let nextEntryId = 1;

export function useAskAi(): UseAskAiResult {
  const [entries, setEntries] = useState<AskEntry[]>([]);
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const ask = useCallback(
    (question: string, scope: AskScope, sessionId?: string) => {
      const q = question.trim();
      if (!q) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const id = nextEntryId++;
      setEntries((prev) => [
        ...prev,
        {
          id,
          question: q,
          scope,
          sessionId,
          answer: "",
          sources: [],
          status: "streaming",
          errorCode: null,
          errorMessage: null,
        },
      ]);
      setStreaming(true);

      const patch = (update: Partial<AskEntry>) =>
        setEntries((prev) =>
          prev.map((e) => (e.id === id ? { ...e, ...update } : e)),
        );

      void postSse(
        "/ask",
        scope === "session"
          ? { question: q, scope, session_id: sessionId }
          : { question: q, scope },
        {
          onDelta: (text) =>
            setEntries((prev) =>
              prev.map((e) =>
                e.id === id ? { ...e, answer: e.answer + text } : e,
              ),
            ),
          onDone: (extra) => {
            const sources = Array.isArray(extra.sources)
              ? (extra.sources as AskSource[])
              : [];
            patch({ status: "done", sources });
            setStreaming(false);
          },
          onError: (code, message) => {
            patch({ status: "error", errorCode: code, errorMessage: message });
            setStreaming(false);
          },
        },
        { signal: controller.signal },
      );
    },
    [],
  );

  return { entries, streaming, ask };
}
