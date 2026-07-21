import { useEffect, useRef, useState, type RefObject } from "react";
import { RT_MODEL, LANGUAGE_HINTS } from "../config";
import { apiFetch, getApiToken } from "../lib/api";
import type { SonioxTokenResponse } from "../lib/api-types";
import { WaveformViz, type WaveColor } from "../lib/waveform";

/**
 * Realtime (online/live) transcription hook backed by Soniox's streaming
 * WebSocket via `@soniox/speech-to-text-web` (model stt-rt-v5, language hints,
 * speaker diarization). Ported from the reference speech-react MVP with these
 * correctness fixes:
 *
 *  - User STOP is graceful: it calls the SDK `stop()`, which waits for buffered
 *    audio to produce final results, and keeps the MediaStream alive until
 *    `onFinished` fires (then releases). Immediate teardown (`cancel()`) is used
 *    only for discard / component unmount, so the last utterance isn't lost.
 *  - Startup is race-safe: a synchronous generation counter is bumped on each
 *    start. After every await (getUserMedia, dynamic import, viz.start,
 *    client.start) we verify the session is still current AND mounted, else we
 *    stop the just-acquired stream/client and bail — no leaked stream on tab
 *    switch or rapid starts. All SDK callbacks are scoped to their generation.
 *  - Final tokens are appended exactly once as they arrive (Soniox sends each
 *    final token a single time; only the non-final/interim tail is replaced).
 *  - getUserMedia is feature-detected up front with a clear error.
 *  - Exactly ONE MediaStream is owned: it is shared with both the SDK (`stream`
 *    option) and WaveformViz, and every track is stopped deterministically.
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

export interface UseSonioxOptions {
  /**
   * Optional injected-stream provider (Meeting capture's mixed stream).
   * Ownership rule: whoever creates a MediaStream stops it — when a stream is
   * injected the hook does NOT own it and never calls track.stop() on it
   * (it still disconnects the waveform viz); the provider (e.g. CaptureMixer)
   * stops the tracks. When absent, the hook getUserMedia's its own stream
   * (owned) — default behavior is byte-identical to v1.
   */
  getStream?: () => Promise<MediaStream>;
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
  options?: UseSonioxOptions,
): UseSoniox {
  const [recordState, setRecordState] = useState<RecordState>("idle");
  const [interimText, setInterimText] = useState("");
  const [micError, setMicError] = useState("");

  const clientRef = useRef<SonioxClientLike | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // True only for the default getUserMedia path; injected streams are owned
  // by their creator (ownership rule) and are never stopped here.
  const ownsStreamRef = useRef(false);
  const getStreamRef = useRef(options?.getStream);
  getStreamRef.current = options?.getStream;
  const vizRef = useRef<WaveformViz | null>(null);
  // Synchronous session id: bumped on every start/cancel/unmount so in-flight
  // async startup and scoped SDK callbacks can detect a stale session.
  const genRef = useRef(0);
  const mountedRef = useRef(true);
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
    // Stop tracks only when this hook created the stream itself; injected
    // streams are stopped by their creator (e.g. CaptureMixer).
    if (ownsStreamRef.current) {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    }
    streamRef.current = null;
    ownsStreamRef.current = false;
  }

  /** True while the given session is still the active one and we're mounted. */
  function isCurrent(gen: number) {
    return gen === genRef.current && mountedRef.current;
  }

  /**
   * Immediate cancel — used for user discard and component unmount. Bumps the
   * generation so any in-flight startup and pending callbacks are invalidated,
   * then terminates the client with `cancel()` (falling back to `stop()`).
   */
  function cancelRecording() {
    genRef.current++;
    const client = clientRef.current;
    if (client?.cancel) client.cancel();
    else client?.stop?.();
    clientRef.current = null;
    teardownAudio();
    setRecordState("idle");
    setInterimText("");
  }

  /**
   * Graceful user stop — calls the SDK `stop()` so buffered audio is flushed
   * into final results; the MediaStream is kept alive until `onFinished` fires
   * (which releases it). If no client exists yet (still connecting), fall back
   * to an immediate cancel.
   */
  function stopRecording() {
    const client = clientRef.current;
    if (client?.stop) {
      client.stop();
      setInterimText("");
      // Intentionally do NOT teardown here — onFinished handles release once
      // the server returns the final results.
    } else {
      cancelRecording();
    }
  }

  async function startListening() {
    setMicError("");
    setInterimText("");

    const injectedGetStream = getStreamRef.current;

    // Feature-detect microphone access before doing anything else (skipped
    // when the caller injects a ready-made stream).
    if (!injectedGetStream && !navigator.mediaDevices?.getUserMedia) {
      setMicError("Microphone not supported in this browser.");
      return;
    }

    // Graceful no-token UX: live transcription needs the backend token to
    // mint a realtime key. Recording (Recorder tab) still works without it.
    if (!getApiToken()) {
      setMicError(
        "Transcription is not configured — paste your API token in Settings to connect to the server.",
      );
      return;
    }

    const gen = ++genRef.current;
    setRecordState("connecting");

    let stream: MediaStream;
    const ownsStream = !injectedGetStream;
    try {
      stream = injectedGetStream
        ? await injectedGetStream()
        : await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      if (isCurrent(gen)) {
        setMicError("Microphone access denied — check browser permissions.");
        setRecordState("idle");
      }
      return;
    }

    // Session changed (tab switch / rapid restart) while acquisition was
    // pending: release this orphan stream (if owned) and bail.
    if (!isCurrent(gen)) {
      if (ownsStream) stream.getTracks().forEach((t) => t.stop());
      return;
    }
    streamRef.current = stream;
    ownsStreamRef.current = ownsStream;

    // Waveform shares the same stream. Color: yellow while connecting, green
    // once listening — read live from recordStateRef.
    const colorRef = (): WaveColor =>
      recordStateRef.current === "listening" ? "listening" : "connecting";
    const viz = new WaveformViz(canvasRef, colorRef);
    vizRef.current = viz;
    try {
      await viz.start(stream);
    } catch {
      // Visualization is non-critical; ignore AudioContext failures.
    }
    if (!isCurrent(gen)) {
      teardownAudio();
      return;
    }

    try {
      const { SonioxClient } = await import("@soniox/speech-to-text-web");
      if (!isCurrent(gen)) {
        teardownAudio();
        return;
      }

      const client = new SonioxClient({
        // SDK ≥1.4 accepts an async apiKey getter; audio buffers until it
        // resolves. The Worker mints a short-lived single-use realtime key,
        // so the permanent Soniox key never reaches the browser.
        apiKey: async () => {
          const { api_key } = await apiFetch<SonioxTokenResponse>(
            "/auth/soniox-token",
            { method: "POST" },
          );
          return api_key;
        },
        onStarted: () => {
          if (!isCurrent(gen)) return;
          setRecordState("listening");
        },
        onPartialResult: (result: SonioxResult) => {
          if (!isCurrent(gen)) return;
          // Soniox sends each final token exactly once, so append all final
          // tokens from this callback verbatim; only the interim tail is
          // recomputed each time.
          const finalText = result.tokens
            .filter((t) => t.is_final)
            .map((t) => t.text)
            .join("");
          if (finalText) onTextRef.current(finalText);
          setInterimText(
            result.tokens
              .filter((t) => !t.is_final)
              .map((t) => t.text)
              .join(""),
          );
        },
        onFinished: () => {
          if (!isCurrent(gen)) return;
          clientRef.current = null;
          teardownAudio();
          setRecordState("idle");
          setInterimText("");
        },
        onError: (_status: string, message: string) => {
          if (!isCurrent(gen)) return;
          setMicError(message || "Microphone error — check browser settings.");
          clientRef.current = null;
          teardownAudio();
          setRecordState("idle");
          setInterimText("");
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

      // Unmounted / restarted while start() was resolving: cancel this client
      // immediately and release resources.
      if (!isCurrent(gen)) {
        if (client.cancel) client.cancel();
        else client.stop?.();
        if (clientRef.current === client) clientRef.current = null;
        teardownAudio();
      }
    } catch {
      if (!isCurrent(gen)) return;
      setMicError("Could not start live transcription — check your connection.");
      clientRef.current = null;
      teardownAudio();
      setRecordState("idle");
    }
  }

  function toggleRecording() {
    if (recordState === "idle") void startListening();
    else if (recordState === "listening") stopRecording();
    // While connecting there is no buffered audio worth flushing — cancel.
    else cancelRecording();
  }

  // Immediate cancel on unmount so the WebSocket + mic never leak.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      genRef.current++;
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
