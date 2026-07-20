/**
 * useRecorder — offline-capable audio capture via getUserMedia + MediaRecorder.
 *
 * Everything here is local: mic capture and encoding require no network, so
 * recording works fully offline. The captured audio is returned to the caller
 * on stop(), which persists it to IndexedDB (see useRecordings).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_RECORDING_MS, RECORDER_TIMESLICE_MS } from "../config";
import { WaveformViz } from "../lib/waveform";

/** Candidate mime types, tried in order via MediaRecorder.isTypeSupported. */
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

export interface CapturedAudio {
  blob: Blob;
  durationMs: number;
  mimeType: string;
  blobSize: number;
}

export interface UseRecorder {
  isRecording: boolean;
  elapsedMs: number;
  error: string | null;
  isSupported: boolean;
  start: () => Promise<void>;
  stop: () => Promise<CapturedAudio | null>;
}

function detectSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof window !== "undefined" &&
    typeof window.MediaRecorder !== "undefined"
  );
}

/** Pick the first supported mime type, or "" to let MediaRecorder decide. */
function negotiateMimeType(): string {
  if (typeof window === "undefined" || !window.MediaRecorder) return "";
  for (const candidate of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return "";
}

export function useRecorder(
  waveformCanvasRef: { current: HTMLCanvasElement | null },
): UseRecorder {
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isSupported] = useState<boolean>(detectSupported);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeTypeRef = useRef<string>("");
  const startTimeRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wavizRef = useRef<WaveformViz | null>(null);
  const autoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Resolver for the promise returned by stop(), fulfilled on recorder.onstop.
  const stopResolveRef = useRef<((value: CapturedAudio | null) => void) | null>(
    null,
  );

  const cleanupCapture = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (autoStopRef.current !== null) {
      clearTimeout(autoStopRef.current);
      autoStopRef.current = null;
    }
    wavizRef.current?.stop();
    wavizRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  const finalizeStop = useCallback(() => {
    const resolve = stopResolveRef.current;
    stopResolveRef.current = null;
    const durationMs = startTimeRef.current
      ? Date.now() - startTimeRef.current
      : elapsedMs;
    const mimeType =
      recorderRef.current?.mimeType || mimeTypeRef.current || "audio/webm";
    const chunks = chunksRef.current;
    chunksRef.current = [];
    cleanupCapture();
    setIsRecording(false);
    recorderRef.current = null;

    if (chunks.length === 0) {
      setError("No audio was captured.");
      resolve?.(null);
      return;
    }
    const blob = new Blob(chunks, { type: mimeType });
    if (blob.size === 0) {
      setError("Recording was empty (0 bytes) and was not saved.");
      resolve?.(null);
      return;
    }
    resolve?.({ blob, durationMs, mimeType, blobSize: blob.size });
  }, [cleanupCapture, elapsedMs]);

  const start = useCallback(async () => {
    if (isRecording) return;
    setError(null);
    if (!detectSupported()) {
      setError("Audio recording is not supported in this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const chosen = negotiateMimeType();
      mimeTypeRef.current = chosen;
      const recorder = chosen
        ? new MediaRecorder(stream, { mimeType: chosen })
        : new MediaRecorder(stream);
      // Read back the actual mime type the recorder settled on.
      mimeTypeRef.current = recorder.mimeType || chosen;
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e: BlobEvent) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onerror = () => {
        setError("A recording error occurred.");
        try {
          recorder.stop();
        } catch {
          /* ignore */
        }
      };
      recorder.onstop = finalizeStop;

      // Waveform shares the SAME MediaStream; AudioContext starts within this
      // user-gesture-triggered call path.
      const viz = new WaveformViz(waveformCanvasRef, () => "recording");
      wavizRef.current = viz;
      try {
        await viz.start(stream);
      } catch {
        // Visualization is non-essential; recording continues without it.
        wavizRef.current = null;
      }

      startTimeRef.current = Date.now();
      setElapsedMs(0);
      timerRef.current = setInterval(() => {
        setElapsedMs(Date.now() - startTimeRef.current);
      }, 200);

      // Enforce the max recording length with an auto-stop.
      autoStopRef.current = setTimeout(() => {
        setError("Reached the maximum recording length — stopped and saved.");
        if (recorderRef.current && recorderRef.current.state !== "inactive") {
          recorderRef.current.stop();
        }
      }, MAX_RECORDING_MS);

      recorder.start(RECORDER_TIMESLICE_MS);
      setIsRecording(true);
    } catch (err) {
      cleanupCapture();
      const message =
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "Microphone permission was denied."
          : err instanceof Error
            ? err.message
            : "Could not start recording.";
      setError(message);
    }
  }, [isRecording, waveformCanvasRef, finalizeStop, cleanupCapture]);

  const stop = useCallback((): Promise<CapturedAudio | null> => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      cleanupCapture();
      setIsRecording(false);
      return Promise.resolve(null);
    }
    return new Promise<CapturedAudio | null>((resolve) => {
      stopResolveRef.current = resolve;
      try {
        recorder.stop();
      } catch {
        finalizeStop();
      }
    });
  }, [cleanupCapture, finalizeStop]);

  // Release the mic + audio nodes if the component unmounts mid-recording.
  useEffect(() => {
    return () => {
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        try {
          recorder.stop();
        } catch {
          /* ignore */
        }
      }
      cleanupCapture();
    };
  }, [cleanupCapture]);

  return { isRecording, elapsedMs, error, isSupported, start, stop };
}
