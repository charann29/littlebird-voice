import { useEffect, useRef, useState, type RefObject } from "react";
import { SONIOX_API_KEY, RT_MODEL, LANGUAGE_HINTS } from "../config";
import { WaveformViz, type WaveColor } from "../lib/waveform";

/**
 * Realtime (online/live) transcription hook backed by Soniox's streaming
 * WebSocket via `@soniox/speech-to-text-web` (model stt-rt-v5, language hints,
 * speaker diarization). Ported from the reference speech-react MVP with the
 * following fixes applied:
 *
 *  - `SonioxClient.start(...)` is async in SDK 1.4: it is awaited and rejection
 *    is handled (error surfaced, returned to idle).
 *  - A `cancelRecording()` path calls the client's `cancel()` (immediate,
 *    resource-freeing) and is invoked on unmount so the WebSocket + mic can't
 *    leak.
 *  - Exactly ONE MediaStream is owned here: we call getUserMedia once, hand the
 *    same stream to the SDK via its `stream` option AND to WaveformViz, then
 *    stop every track of that one stream deterministically on stop/cancel.
 *  - getUserMedia is feature-detected up front with a clear error.
 *  - Visualization uses the shared WaveformViz.
 */

type RecordState = "idle" | "connecting" | "listening";

/** Minimal token/response shapes we rely on (SDK response is loosely typed). */
interface SonioxToken {
  text: string;
  is_final: boolean;
}
interface SonioxResult {
  tokens: SonioxToken[];
}

/** Narrow structural type for the SonioxClient instance we use. */
interface SonioxClientLike {
  start: (opts: Record<string, unknown>) => Promise<void>;
  stop?: () => void;
  cancel?: () => void;
}

export interface UseSoniox {
  recordState: RecordState;
  isRecording: boolean;
  isConnecting: boolean;
  interimText: string;
  micError: string;
  toggleRecording: () => void;
  cancelRecording: () => void;
}

export function useSoniox(
  onText: (text: string) => void,
  canvasRef: RefObject<HTMLCanvasElement | null>,
): UseSoniox {
  const [recordState, setRecordState] = useState<RecordState>("idle");
  const [interimText, setInterimText] = useState("");
  const [micError, setMicError] = useState("");

  const clientRef = useRef<SonioxClientLike | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const vizRef = useRef<WaveformViz | null>(null);
  const lastFinalTextRef = useRef("");
  // ref so WaveformViz's color callback always reads the current state
  const recordStateRef = useRef<RecordState>("idle");

  // keep latest onText without forcing effect re-runs / stale closures
  const onTextRef = useRef(onText);
  useEffect(() => {
    onTextRef.current = onText;
  }, [onText]);

  useEffect(() => {
    recordStateRef.current = recordState;
  }, [recordState]);

  /** Release the single owned MediaStream + waveform nodes deterministically. */
  function teardownAudio() {
    vizRef.current?.stop();
    vizRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  function reset(state: RecordState) {
    setRecordState(state);
    setInterimText("");
    lastFinalTextRef.current = "";
  }

  /** Immediate cancel — used by the user (toggle off) and on unmount. */
  function cancelRecording() {
    const client = clientRef.current;
    // Prefer cancel() (immediate, closes resources); fall back to stop().
    if (client?.cancel) client.cancel();
    else client?.stop?.();
    clientRef.current = null;
    teardownAudio();
    reset("idle");
  }

  async function startListening() {
    setMicError("");
    setInterimText("");
    lastFinalTextRef.current = "";

    // Feature-detect microphone access before doing anything else.
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicError("Microphone not supported in this browser.");
      return;
    }

    setRecordState("connecting");

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setMicError("Microphone access denied — check browser permissions.");
      setRecordState("idle");
      return;
    }
    streamRef.current = stream;

    // Waveform shares the same stream. Color: yellow while connecting, green
    // once listening — read live from recordStateRef.
    const colorRef = (): WaveColor =>
      recordStateRef.current === "listening" ? "listening" : "connecting";
    const viz = new WaveformViz(canvasRef, colorRef);
    vizRef.current = viz;
    void viz.start(stream);

    try {
      const { SonioxClient } = await import("@soniox/speech-to-text-web");
      const client = new SonioxClient({
        apiKey: SONIOX_API_KEY,
        onStarted: () => setRecordState("listening"),
        onPartialResult: (result: SonioxResult) => {
          const currentFinal = result.tokens
            .filter((t) => t.is_final)
            .map((t) => t.text)
            .join("");
          // Emit only the newly finalized suffix to avoid re-appending text.
          const newFinal = currentFinal.startsWith(lastFinalTextRef.current)
            ? currentFinal.slice(lastFinalTextRef.current.length)
            : currentFinal;
          if (newFinal) {
            onTextRef.current(newFinal);
            lastFinalTextRef.current = currentFinal;
          }
          setInterimText(
            result.tokens
              .filter((t) => !t.is_final)
              .map((t) => t.text)
              .join(""),
          );
        },
        onFinished: () => {
          clientRef.current = null;
          teardownAudio();
          reset("idle");
        },
        onError: (_status: string, message: string) => {
          setMicError(message || "Microphone error — check browser settings.");
          clientRef.current = null;
          teardownAudio();
          reset("idle");
        },
      }) as unknown as SonioxClientLike;
      clientRef.current = client;

      // start() is async in SDK 1.4 — await and handle rejection.
      await client.start({
        model: RT_MODEL,
        languageHints: LANGUAGE_HINTS,
        enableSpeakerDiarization: true,
        stream, // share the one owned MediaStream with the SDK
      });
    } catch {
      setMicError("Could not start live transcription — check your connection.");
      clientRef.current = null;
      teardownAudio();
      setRecordState("idle");
    }
  }

  function toggleRecording() {
    if (recordState === "idle") void startListening();
    else cancelRecording();
  }

  // Cancel on unmount so the WebSocket + mic never leak.
  useEffect(() => {
    return () => {
      const client = clientRef.current;
      if (client?.cancel) client.cancel();
      else client?.stop?.();
      clientRef.current = null;
      teardownAudio();
    };
  }, []);

  return {
    recordState,
    isRecording: recordState === "listening",
    isConnecting: recordState === "connecting",
    interimText,
    micError,
    toggleRecording,
    cancelRecording,
  };
}
