/**
 * useRecordings — React Context that owns the in-memory mirror of all
 * recordings and orchestrates their transcription lifecycle.
 *
 * The IndexedDB store (lib/db) is the source of truth; this context hydrates
 * from it on mount and keeps a React-state mirror so components re-render on
 * changes. Transcription runs through lib/soniox-async and persists progress
 * (soniox ids) immediately for crash recovery.
 *
 * Concurrency model:
 *  - `activeRef` is the SYNCHRONOUS source of truth for "is this id currently
 *    transcribing?" — reserved before the first await to defeat double-start
 *    races (rapid clicks, click during a queue drain).
 *  - `runRef` holds the in-flight promise per id so remove() can abort AND
 *    await it before deleting (prevents a late write resurrecting the record).
 *  - `tombstonesRef` records deleted ids so any late persistence is dropped.
 *  - `activeIds` mirrors activeRef into state so buttons can disable instantly.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  Recording,
  TranscribeStage,
  TranscriptSegment,
} from "../types";
import {
  deleteRecordingAndEnqueue,
  getAllRecordings,
  getRecording,
  putRecordingAndEnqueue,
  updateRecording,
  updateRecordingAndEnqueue,
} from "../lib/db";
import { drainOutbox, installSyncTriggers } from "../lib/sync";
import {
  deleteRemote,
  resumePoll,
  transcribeBlob,
  TranscriptionTerminalError,
} from "../lib/soniox-async";
import type { CapturedAudio } from "./useRecorder";

/** Max stranded recordings recovered concurrently on hydration. */
const RECOVERY_CONCURRENCY = 3;

export interface RecordingsContextValue {
  recordings: Recording[];
  /** Per-id transient transcription stage (not persisted). */
  stages: Record<string, TranscribeStage | undefined>;
  /** Ids currently transcribing (immediate, for button disabling). */
  activeIds: string[];
  refresh: () => Promise<void>;
  addFromBlob: (captured: CapturedAudio) => Promise<Recording>;
  transcribeOne: (id: string) => Promise<void>;
  transcribeAllPending: () => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** Persist a rename locally (survives reload) and enqueue a server sync. */
  rename: (id: string, title: string) => Promise<void>;
}

const RecordingsContext = createContext<RecordingsContextValue | null>(null);

export function RecordingsProvider({ children }: { children: ReactNode }) {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [stages, setStages] = useState<
    Record<string, TranscribeStage | undefined>
  >({});
  const [activeIds, setActiveIds] = useState<string[]>([]);

  // One AbortController per actively-transcribing id.
  const controllersRef = useRef<Map<string, AbortController>>(new Map());
  // Synchronous guard against double-starting the same id.
  const activeRef = useRef<Set<string>>(new Set());
  // In-flight transcription promise per id (so remove() can await it).
  const runRef = useRef<Map<string, Promise<void>>>(new Map());
  // Ids that were deleted — any late persistence for them must be dropped.
  const tombstonesRef = useRef<Set<string>>(new Set());
  // Guards against concurrent queue drains.
  const drainingRef = useRef(false);

  const applyLocal = useCallback((id: string, patch: Partial<Recording>) => {
    setRecordings((prev) =>
      prev.map((r) => (r.id === id ? { ...r, ...patch, id: r.id } : r)),
    );
  }, []);

  /**
   * Persist a patch to IndexedDB and mirror it into React state, UNLESS the id
   * has been tombstoned (deleted) — dropping the write prevents resurrecting a
   * record between remove()'s read and this write. (db.updateRecording is also
   * a no-op when the record is already gone.)
   */
  const persist = useCallback(
    async (id: string, patch: Partial<Recording>) => {
      if (tombstonesRef.current.has(id)) return;
      await updateRecording(id, patch);
      if (tombstonesRef.current.has(id)) return;
      applyLocal(id, patch);
    },
    [applyLocal],
  );

  /**
   * Persist a patch that MUST sync to the server: atomic
   * updateRecordingAndEnqueue (one transaction spanning recordings +
   * syncOutbox), then kick a drain. Used for transcribe-done/edit; transient
   * flips (status: "transcribing", soniox ids) keep plain persist().
   */
  const persistAndSync = useCallback(
    async (id: string, patch: Partial<Recording>) => {
      if (tombstonesRef.current.has(id)) return;
      await updateRecordingAndEnqueue(id, patch);
      if (tombstonesRef.current.has(id)) return;
      applyLocal(id, { ...patch, syncState: "dirty" });
      void drainOutbox();
    },
    [applyLocal],
  );

  const setStage = useCallback(
    (id: string, stage: TranscribeStage | undefined) => {
      setStages((prev) => ({ ...prev, [id]: stage }));
    },
    [],
  );

  const beginActive = useCallback((id: string): AbortController => {
    activeRef.current.add(id);
    const controller = new AbortController();
    controllersRef.current.set(id, controller);
    setActiveIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    return controller;
  }, []);

  const endActive = useCallback((id: string) => {
    activeRef.current.delete(id);
    controllersRef.current.delete(id);
    setActiveIds((prev) => prev.filter((x) => x !== id));
    setStage(id, undefined);
  }, [setStage]);

  const refresh = useCallback(async () => {
    const all = await getAllRecordings();
    setRecordings(all);
  }, []);

  const addFromBlob = useCallback(
    async (captured: CapturedAudio): Promise<Recording> => {
      const recording: Recording = {
        id: crypto.randomUUID(),
        title: null,
        createdAt: Date.now(),
        durationMs: captured.durationMs,
        mimeType: captured.mimeType,
        blobSize: captured.blobSize,
        blob: captured.blob,
        status: "pending",
        transcript: null,
        error: null,
        sonioxFileId: null,
        sonioxTranscriptionId: null,
        segments: null,
        syncState: "local",
      };
      await putRecordingAndEnqueue(recording);
      setRecordings((prev) => [{ ...recording, syncState: "dirty" }, ...prev]);
      void drainOutbox();
      return recording;
    },
    [],
  );

  const transcribeOne = useCallback(
    (id: string): Promise<void> => {
      // Synchronous double-start guard: reserve BEFORE any await.
      if (activeRef.current.has(id)) {
        return runRef.current.get(id) ?? Promise.resolve();
      }
      if (tombstonesRef.current.has(id)) return Promise.resolve();
      const controller = beginActive(id);

      const run = (async () => {
        try {
          const current = await getRecording(id);
          if (!current || tombstonesRef.current.has(id)) return;
          // Already finished elsewhere; nothing to do.
          if (current.status === "done") return;

          await persist(id, { status: "transcribing", error: null });

          let transcript: string;
          let segments: TranscriptSegment[] | null;
          let fileId: string | null = current.sonioxFileId;
          let transcriptionId: string | null = current.sonioxTranscriptionId;

          if (current.sonioxTranscriptionId) {
            // RESUME an existing job rather than re-uploading (avoids leaking a
            // duplicate remote file/job on retry).
            setStage(id, "polling");
            const fetched = await resumePoll(
              current.sonioxTranscriptionId,
              controller.signal,
            );
            transcript = fetched.text;
            segments = fetched.segments;
          } else {
            // Fresh transcription from the local blob.
            setStage(id, "uploading");
            const result = await transcribeBlob(current.blob, {
              signal: controller.signal,
              onStage: (stage) => setStage(id, stage),
              onIds: async (ids) => {
                // AWAIT the id commit so it is durable before advancing; abort
                // if the record was deleted underneath us.
                if (tombstonesRef.current.has(id)) {
                  throw new DOMException("Aborted", "AbortError");
                }
                if (ids.fileId) {
                  await persist(id, { sonioxFileId: ids.fileId });
                }
                if (ids.transcriptionId) {
                  await persist(id, {
                    sonioxTranscriptionId: ids.transcriptionId,
                  });
                }
              },
            });
            transcript = result.transcript;
            segments = result.segments;
            fileId = result.fileId;
            transcriptionId = result.transcriptionId;
          }

          // Durable, server-bound write: enqueue an upsert atomically with the
          // recording update, then kick a sync pass.
          await persistAndSync(id, {
            status: "done",
            transcript,
            segments,
            error: null,
            sonioxFileId: fileId,
            sonioxTranscriptionId: transcriptionId,
          });
          // Best-effort remote cleanup after success (non-fatal).
          void deleteRemote(fileId, transcriptionId);
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") {
            // Aborted (e.g. deleted mid-flight); leave state to the caller.
            return;
          }
          const message =
            err instanceof Error ? err.message : "Transcription failed.";
          const isTerminal = err instanceof TranscriptionTerminalError;

          // Re-read the ids actually persisted (onIds may have committed them).
          const rec = await getRecording(id);
          const fileId = rec?.sonioxFileId ?? null;
          const txId = rec?.sonioxTranscriptionId ?? null;

          if (txId && !isTerminal) {
            // Transient failure with a resumable job — KEEP ids so a retry can
            // resume the same remote job instead of starting a new one.
            await persist(id, { status: "error", error: message });
          } else {
            // Terminal failure, OR an orphaned upload with no resumable job:
            // best-effort delete the known remote resources and clear the ids
            // so a retry starts cleanly (no leaked/duplicate jobs).
            if (fileId || txId) void deleteRemote(fileId, txId);
            await persist(id, {
              status: "error",
              error: message,
              sonioxFileId: null,
              sonioxTranscriptionId: null,
            });
          }
        } finally {
          endActive(id);
          runRef.current.delete(id);
        }
      })();

      runRef.current.set(id, run);
      return run;
    },
    [beginActive, endActive, persist, persistAndSync, setStage],
  );

  /**
   * Drain the pending queue sequentially. Guarded against concurrent drains;
   * skips ids already transcribing or tombstoned; per-item failures do not
   * abort the batch (each item records its own error and stays retryable).
   */
  const drainPending = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      const all = await getAllRecordings();
      const pending = all.filter(
        (r) =>
          r.status === "pending" &&
          !activeRef.current.has(r.id) &&
          !tombstonesRef.current.has(r.id),
      );
      for (const rec of pending) {
        try {
          await transcribeOne(rec.id);
        } catch {
          /* transcribeOne records its own error; keep going */
        }
      }
    } finally {
      drainingRef.current = false;
    }
  }, [transcribeOne]);

  const transcribeAllPending = useCallback(
    () => drainPending(),
    [drainPending],
  );

  /**
   * Rename a local recording: durable IndexedDB write + outbox upsert (one
   * transaction), so the title survives reloads offline and reaches the
   * server on the next drain.
   */
  const rename = useCallback(
    async (id: string, title: string) => {
      await persistAndSync(id, { title });
    },
    [persistAndSync],
  );

  const remove = useCallback(async (id: string) => {
    // Tombstone first so any late persistence for this id is dropped.
    tombstonesRef.current.add(id);
    // Abort and AWAIT any in-flight transcription so no write lands after the
    // delete (which would resurrect the record).
    const controller = controllersRef.current.get(id);
    controller?.abort();
    const inflight = runRef.current.get(id);
    if (inflight) {
      try {
        await inflight;
      } catch {
        /* ignore */
      }
    }
    const existing = await getRecording(id);
    // Atomic: delete the row, drop queued ops for it, and enqueue a delete
    // tombstone for the server — all in one transaction.
    await deleteRecordingAndEnqueue(id);
    void drainOutbox();
    setRecordings((prev) => prev.filter((r) => r.id !== id));
    setStages((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setActiveIds((prev) => prev.filter((x) => x !== id));
    if (existing?.sonioxFileId || existing?.sonioxTranscriptionId) {
      void deleteRemote(existing.sonioxFileId, existing.sonioxTranscriptionId);
    }
  }, []);

  // Hydrate + reconcile stranded "transcribing" items on mount, then kick off
  // an initial queue drain if we appear to be online.
  useEffect(() => {
    let cancelled = false;

    // Durable-sync triggers (online + token changes) and an initial drain of
    // any ops queued while the app was closed. Idempotent.
    installSyncTriggers();
    void drainOutbox();

    const recoverStranded = async (rec: Recording) => {
      if (cancelled || activeRef.current.has(rec.id)) return;
      if (rec.sonioxTranscriptionId) {
        // Resume the existing job (guarded, defensive).
        const controller = beginActive(rec.id);
        setStage(rec.id, "polling");
        try {
          const fetched = await resumePoll(
            rec.sonioxTranscriptionId,
            controller.signal,
          );
          if (cancelled) return;
          await persistAndSync(rec.id, {
            status: "done",
            transcript: fetched.text,
            segments: fetched.segments,
            error: null,
          });
          void deleteRemote(rec.sonioxFileId, rec.sonioxTranscriptionId);
        } catch (err) {
          if (cancelled) return;
          if (err instanceof DOMException && err.name === "AbortError") {
            // ignore
          } else if (err instanceof TranscriptionTerminalError) {
            // Terminal: clean up remote + clear ids so a retry starts fresh.
            void deleteRemote(rec.sonioxFileId, rec.sonioxTranscriptionId);
            await persist(rec.id, {
              status: "pending",
              error: null,
              sonioxFileId: null,
              sonioxTranscriptionId: null,
            });
          } else {
            // Transient: keep ids so a later retry can RESUME the same job.
            await persist(rec.id, { status: "pending", error: null });
          }
        } finally {
          endActive(rec.id);
        }
      } else {
        // No remote id — nothing to resume; reset to pending.
        try {
          await persist(rec.id, { status: "pending", error: null });
        } catch {
          /* defensive: don't block render */
        }
      }
    };

    (async () => {
      const all = await getAllRecordings();
      if (cancelled) return;
      setRecordings(all);

      const stranded = all.filter((r) => r.status === "transcribing");
      // Recover with bounded concurrency (Promise.allSettled per batch).
      for (let i = 0; i < stranded.length; i += RECOVERY_CONCURRENCY) {
        if (cancelled) return;
        const batch = stranded.slice(i, i + RECOVERY_CONCURRENCY);
        await Promise.allSettled(batch.map(recoverStranded));
      }

      // Initial auto-drain: navigator.onLine is a TRIGGER (not proof of
      // reachability) — per-item failures stay retryable.
      if (
        !cancelled &&
        typeof navigator !== "undefined" &&
        navigator.onLine
      ) {
        void drainPending();
      }
    })().catch(() => {
      /* defensive: hydration failure must not block initial render */
    });

    return () => {
      cancelled = true;
    };
  }, [beginActive, endActive, persist, persistAndSync, setStage, drainPending]);

  // Auto-transcribe pending items whenever connectivity transitions to online.
  useEffect(() => {
    const onOnline = () => {
      void drainPending();
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [drainPending]);

  // On provider unmount, abort ALL in-flight transcriptions.
  useEffect(() => {
    const controllers = controllersRef.current;
    return () => {
      for (const c of controllers.values()) c.abort();
      controllers.clear();
    };
  }, []);

  const value: RecordingsContextValue = {
    recordings,
    stages,
    activeIds,
    refresh,
    addFromBlob,
    transcribeOne,
    transcribeAllPending,
    remove,
    rename,
  };

  return (
    <RecordingsContext.Provider value={value}>
      {children}
    </RecordingsContext.Provider>
  );
}

export function useRecordings(): RecordingsContextValue {
  const ctx = useContext(RecordingsContext);
  if (!ctx) {
    throw new Error("useRecordings must be used within a RecordingsProvider");
  }
  return ctx;
}
