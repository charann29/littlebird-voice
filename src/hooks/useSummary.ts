/**
 * useSummary(sessionId) — stored meeting summary + generate/regenerate.
 *
 * States: "loading" (initial GET in flight) → "idle" (no summary yet) or
 * "ready"; `generate()` moves to "generating" (POST summarize; a 202 queued
 * response polls GET .../summary until the new revision lands) then back to
 * "ready" or "error" (with `errorCode` e.g. transcript_not_ready,
 * ai_unavailable, ai_bad_output).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, ApiError } from "../lib/api";
import type {
  StoredSummaryResponse,
  SummarizeQueuedResponse,
  SummarizeResponse,
  SummaryV1,
} from "../lib/ai-types";

export type SummaryStatus =
  | "loading"
  | "idle"
  | "generating"
  | "ready"
  | "error";

export interface UseSummaryResult {
  summary: SummaryV1 | null;
  /** Epoch ms of the stored row, when known. */
  generatedAt: number | null;
  status: SummaryStatus;
  errorCode: string | null;
  errorMessage: string | null;
  generate: () => void;
}

const POLL_INTERVAL_MS = 2500;
const POLL_MAX_ATTEMPTS = 60; // ~2.5 min of polling for queued map-reduce jobs

export function useSummary(sessionId: string): UseSummaryResult {
  const [summary, setSummary] = useState<SummaryV1 | null>(null);
  const [generatedAt, setGeneratedAt] = useState<number | null>(null);
  const [status, setStatus] = useState<SummaryStatus>("loading");
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const generationRef = useRef(0);

  // Initial load of the stored summary.
  useEffect(() => {
    let cancelled = false;
    generationRef.current += 1;
    setSummary(null);
    setGeneratedAt(null);
    setErrorCode(null);
    setErrorMessage(null);
    setStatus("loading");
    apiFetch<StoredSummaryResponse>(`/sessions/${sessionId}/summary`)
      .then((res) => {
        if (cancelled) return;
        setSummary(res.summary);
        setGeneratedAt(res.generated_at);
        setStatus("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.code === "no_summary") {
          setStatus("idle");
          return;
        }
        setErrorCode(err instanceof ApiError ? err.code : "network");
        setErrorMessage(err instanceof Error ? err.message : "Load failed");
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const generate = useCallback(() => {
    const gen = ++generationRef.current;
    const live = () => generationRef.current === gen;
    setErrorCode(null);
    setErrorMessage(null);
    setStatus("generating");

    const fail = (err: unknown) => {
      if (!live()) return;
      setErrorCode(err instanceof ApiError ? err.code : "network");
      setErrorMessage(
        err instanceof Error ? err.message : "Summary generation failed",
      );
      setStatus("error");
    };

    const succeed = (s: SummaryV1, at: number | null) => {
      if (!live()) return;
      setSummary(s);
      setGeneratedAt(at);
      setStatus("ready");
    };

    void (async () => {
      let res: SummarizeResponse | SummarizeQueuedResponse;
      try {
        res = await apiFetch<SummarizeResponse | SummarizeQueuedResponse>(
          `/sessions/${sessionId}/summarize`,
          { method: "POST" },
        );
      } catch (err) {
        fail(err);
        return;
      }

      if ("summary" in res) {
        succeed(res.summary, Date.now());
        return;
      }

      // 202 queued (long transcript, map-reduce runs on the queue): poll the
      // stored summary until a row newer than what we had shows up.
      const prevRequestId = summary?.request_id ?? null;
      const prevRevision = summary?.source_revision ?? null;
      for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        if (!live()) return;
        try {
          const stored = await apiFetch<StoredSummaryResponse>(
            `/sessions/${sessionId}/summary`,
          );
          const changed =
            stored.summary.request_id !== prevRequestId ||
            stored.summary.source_revision !== prevRevision;
          if (prevRequestId === null && prevRevision === null) {
            // No prior summary: any stored row is the result.
            succeed(stored.summary, stored.generated_at);
            return;
          }
          if (changed) {
            succeed(stored.summary, stored.generated_at);
            return;
          }
        } catch (err) {
          if (err instanceof ApiError && err.code === "no_summary") continue;
          fail(err);
          return;
        }
      }
      if (live()) {
        setErrorCode("timeout");
        setErrorMessage(
          "Summary is still generating in the background — check back shortly.",
        );
        setStatus("error");
      }
    })();
    // `summary` is intentionally read at call time via closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, summary]);

  return { summary, generatedAt, status, errorCode, errorMessage, generate };
}
