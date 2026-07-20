/**
 * useRecordings — React Context that owns the in-memory mirror of all
 * recordings and orchestrates their transcription lifecycle.
 *
 * The IndexedDB store (lib/db) is the source of truth; this context hydrates
 * from it on mount and keeps a React-state mirror so components re-render on
 * changes. Transcription runs through lib/soniox-async and persists progress
 * (soniox ids) immediately for crash recovery.
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
import type { Recording, TranscribeStage } from "../types";
import {
  addRecording,
  deleteRecording,
  getAllRecordings,
  getRecording,
  updateRecording,
} from "../lib/db";
import {
  deleteRemote,
  resumePoll,
  transcribeBlob,
} from "../lib/soniox-async";
import type { CapturedAudio } from "./useRecorder";

export interface RecordingsContextValue {
  recordings: Recording[];
  /** Per-id transient transcription stage (not persisted). */
  stages: Record<string, TranscribeStage | undefined>;
  refresh: () => Promise<void>;
  addFromBlob: (captured: CapturedAudio) => Promise<Recording>;
  transcribeOne: (id: string) => Promise<void>;
  transcribeAllPending: () => Promise<void>;
  remove: (id: string) => Promise<void>;
}

const RecordingsContext = createContext<RecordingsContextValue | null>(null);

export function RecordingsProvider({ children }: { children: ReactNode }) {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [stages, setStages] = useState<
    Record<string, TranscribeStage | undefined>
  >({});

  // One AbortController per actively-transcribing id.
  const controllersRef = useRef<Map<string, AbortController>>(new Map());
  // Ids currently transcribing, guards against double-starting the same id.
  const activeRef = useRef<Set<string>>(new Set());

  const applyLocal = useCallback((id: string, patch: Partial<Recording>) => {
    setRecordings((prev) =>
      prev.map((r) => (r.id === id ? { ...r, ...patch, id: r.id } : r)),
    );
  }, []);

  /** Persist a patch to IndexedDB and mirror it into React state. */
  const persist = useCallback(
    async (id: string, patch: Partial<Recording>) => {
      await updateRecording(id, patch);
      applyLocal(id, patch);
    },
    [applyLocal],
  );

  const setStage = useCallback(
    (id: string, stage: TranscribeStage | undefined) => {
      setStages((prev) => ({ ...prev, [id]: stage }));
    },
    [],
  );

  const refresh = useCallback(async () => {
    const all = await getAllRecordings();
    setRecordings(all);
  }, []);

  const addFromBlob = useCallback(
    async (captured: CapturedAudio): Promise<Recording> => {
      const recording: Recording = {
        id: crypto.randomUUID(),
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
      };
      await addRecording(recording);
      setRecordings((prev) => [recording, ...prev]);
      return recording;
    },
    [],
  );

  const transcribeOne = useCallback(
    async (id: string) => {
      // Guard: never run the same id twice concurrently.
      if (activeRef.current.has(id)) return;

      const current = await getRecording(id);
      if (!current) return;
      if (current.status === "transcribing") return;

      activeRef.current.add(id);
      const controller = new AbortController();
      controllersRef.current.set(id, controller);

      await persist(id, { status: "transcribing", error: null });
      setStage(id, "uploading");

      try {
        const result = await transcribeBlob(current.blob, {
          signal: controller.signal,
          onStage: (stage) => setStage(id, stage),
          onIds: ({ fileId, transcriptionId }) => {
            // Persist ids IMMEDIATELY for crash recovery.
            if (fileId) void persist(id, { sonioxFileId: fileId });
            if (transcriptionId) {
              void persist(id, { sonioxTranscriptionId: transcriptionId });
            }
          },
        });

        await persist(id, {
          status: "done",
          transcript: result.transcript,
          error: null,
          sonioxFileId: result.fileId,
          sonioxTranscriptionId: result.transcriptionId,
        });

        // Best-effort remote cleanup after success (non-fatal).
        void deleteRemote(result.fileId, result.transcriptionId);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          // Aborted (e.g. deleted mid-flight); leave state to the caller.
          return;
        }
        const message =
          err instanceof Error ? err.message : "Transcription failed.";
        await persist(id, { status: "error", error: message });
      } finally {
        activeRef.current.delete(id);
        controllersRef.current.delete(id);
        setStage(id, undefined);
      }
    },
    [persist, setStage],
  );

  const transcribeAllPending = useCallback(async () => {
    const all = await getAllRecordings();
    const pending = all.filter((r) => r.status === "pending");
    for (const rec of pending) {
      // Sequential; continue past individual failures.
      try {
        await transcribeOne(rec.id);
      } catch {
        /* transcribeOne records its own error; keep going */
      }
    }
  }, [transcribeOne]);

  const remove = useCallback(async (id: string) => {
    // Abort any in-flight transcription for this id first.
    const controller = controllersRef.current.get(id);
    if (controller) {
      controller.abort();
      controllersRef.current.delete(id);
      activeRef.current.delete(id);
    }
    const existing = await getRecording(id);
    await deleteRecording(id);
    setRecordings((prev) => prev.filter((r) => r.id !== id));
    setStages((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    if (existing?.sonioxFileId || existing?.sonioxTranscriptionId) {
      void deleteRemote(existing.sonioxFileId, existing.sonioxTranscriptionId);
    }
  }, []);

  // Hydrate + reconcile stranded "transcribing" items on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const all = await getAllRecordings();
      if (cancelled) return;
      setRecordings(all);

      const stranded = all.filter((r) => r.status === "transcribing");
      for (const rec of stranded) {
        if (rec.sonioxTranscriptionId) {
          // Try to resume the existing job (guarded, defensive).
          if (activeRef.current.has(rec.id)) continue;
          activeRef.current.add(rec.id);
          const controller = new AbortController();
          controllersRef.current.set(rec.id, controller);
          setStage(rec.id, "polling");
          try {
            const transcript = await resumePoll(
              rec.sonioxTranscriptionId,
              controller.signal,
            );
            await persist(rec.id, {
              status: "done",
              transcript,
              error: null,
            });
            void deleteRemote(rec.sonioxFileId, rec.sonioxTranscriptionId);
          } catch (err) {
            if (err instanceof DOMException && err.name === "AbortError") {
              // ignore
            } else {
              // Recovery failed: reset to pending so it can be retried.
              await persist(rec.id, { status: "pending", error: null });
            }
          } finally {
            activeRef.current.delete(rec.id);
            controllersRef.current.delete(rec.id);
            setStage(rec.id, undefined);
          }
        } else {
          // No remote id — nothing to resume; reset to pending.
          try {
            await persist(rec.id, { status: "pending", error: null });
          } catch {
            /* defensive: don't block render */
          }
        }
      }
    })().catch(() => {
      /* defensive: hydration failure must not block initial render */
    });
    return () => {
      cancelled = true;
    };
  }, [persist, setStage]);

  const value: RecordingsContextValue = {
    recordings,
    stages,
    refresh,
    addFromBlob,
    transcribeOne,
    transcribeAllPending,
    remove,
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
