/**
 * useMeetingCapture — orchestrator for Meeting mode (plan 40 Track A, T2).
 *
 * Composes CaptureMixer + useSoniox + useRecorder (both with an injected
 * mixed-stream `getStream`) so one mixed audio stream feeds BOTH the live
 * Soniox path and the offline-durable MediaRecorder queue; completed audio is
 * persisted through useRecordings().addFromBlob — the same path as the
 * Recorder tab.
 *
 * CRITICAL activation-order rule: for the mixed modes, the getUserMedia AND
 * getDisplayMedia promises are created SYNCHRONOUSLY inside the click handler
 * (no intervening await), then awaited together via Promise.allSettled.
 * getDisplayMedia consumes transient user activation — awaiting the mic
 * prompt first can leave the activation expired and make getDisplayMedia
 * reject with InvalidStateError.
 *
 * The browser share picker is AUTHORITATIVE: modes only pass dictionary
 * hints (preferCurrentTab / selfBrowserSurface / systemAudio) and guidance
 * copy; if the user picks a different surface, capture proceeds with
 * whatever audio the picker granted.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  CaptureMixer,
  getCaptureSupport,
  type CaptureLevels,
  type CaptureSupport,
  type DisplayMediaOptions,
} from "../lib/captureMixer";
import { useSoniox } from "./useSoniox";
import { useRecorder, type CapturedAudio } from "./useRecorder";
import { useRecordings } from "./useRecordings";

export type MeetingCaptureMode = "mic" | "tab" | "screen";

export type MeetingCaptureState =
  | "idle"
  | "acquiring" // permission prompts / share picker open
  | "live" // mixer running, recorder started (soniox may still be connecting)
  | "stopping"; // graceful wind-down (soniox flush + recorder finalize)

export interface ActiveSources {
  mic: boolean;
  display: boolean;
}

export interface UseMeetingCapture {
  mode: MeetingCaptureMode;
  setMode: (mode: MeetingCaptureMode) => void;
  state: MeetingCaptureState;
  /** Per-channel RMS levels 0..1, polled while live. */
  levels: CaptureLevels;
  activeSources: ActiveSources;
  /** Non-fatal condition (no tab audio shared, share stopped, live path down). */
  warning: string | null;
  /** Fatal-for-this-attempt condition (mic denied, share cancelled). */
  error: string | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** ms since recording started (from the MediaRecorder path). */
  elapsedMs: number;
  /** Accumulated final transcript text from the live Soniox path. */
  finalText: string;
  /** Current interim (non-final) tail from the live Soniox path. */
  interimText: string;
  /** Browser capability probe result (for disabling picker options). */
  support: CaptureSupport;
}

const LEVEL_POLL_MS = 100;
/** Give the graceful Soniox flush this long before forcing mixer teardown. */
const STOP_FLUSH_TIMEOUT_MS = 8000;

export const WARN_NO_TAB_AUDIO =
  "No tab audio shared — only your mic is being captured. Re-start and tick “Also share tab audio” in the share dialog to capture the call.";
export const WARN_SHARE_ENDED =
  "Screen/tab sharing stopped — continuing with mic only. Your recording is still being saved.";
export const WARN_LIVE_DOWN =
  "Live transcription stopped — your recording continues and will be transcribed when you stop.";
export const ERR_MIC_DENIED =
  "Microphone access denied — check browser permissions.";
export const ERR_SHARE_CANCELLED =
  "Screen/tab share was cancelled — nothing was captured. Try again, or switch to Mic only.";

function displayOptionsFor(mode: MeetingCaptureMode): DisplayMediaOptions {
  return {
    // Chrome requires video to be requested; the video track goes unused for
    // audio-only mixing (kept alive by the mixer, stopped on mixer.stop()).
    video: true,
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    // HINTS only — the user's picker choice always wins.
    selfBrowserSurface: "exclude",
    preferCurrentTab: false,
    systemAudio: mode === "screen" ? "include" : "exclude",
  };
}

export function useMeetingCapture(
  canvasRef: RefObject<HTMLCanvasElement | null>,
): UseMeetingCapture {
  const support = useMemo(() => getCaptureSupport(), []);
  const [mode, setMode] = useState<MeetingCaptureMode>(
    support.tabAudio ? "tab" : "mic",
  );
  const [state, setState] = useState<MeetingCaptureState>("idle");
  const [levels, setLevels] = useState<CaptureLevels>({ mic: 0, display: null });
  const [activeSources, setActiveSources] = useState<ActiveSources>({
    mic: false,
    display: false,
  });
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [finalText, setFinalText] = useState("");

  const mixerRef = useRef<CaptureMixer | null>(null);
  const mixedStreamRef = useRef<MediaStream | null>(null);
  // Synchronous re-entrancy guard for start()/stop().
  const busyRef = useRef(false);
  const stopFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { addFromBlob } = useRecordings();

  const handleComplete = useCallback(
    async (captured: CapturedAudio) => {
      // Same persistence path as the Recorder tab (IndexedDB queue).
      await addFromBlob(captured);
    },
    [addFromBlob],
  );

  const getInjectedStream = useCallback(async (): Promise<MediaStream> => {
    const stream = mixedStreamRef.current;
    if (!stream) throw new Error("Meeting capture has no active mixed stream");
    return stream;
  }, []);

  const soniox = useSoniox(
    (text) => {
      setFinalText((prev) => {
        const prefix = prev.length > 0 && !prev.endsWith(" ") ? " " : "";
        return prev + prefix + text;
      });
    },
    canvasRef,
    { getStream: getInjectedStream },
  );

  const recorder = useRecorder(canvasRef, {
    onComplete: handleComplete,
    getStream: getInjectedStream,
  });

  /** Tear down the mixer + refs (does NOT touch soniox/recorder). */
  const teardownMixer = useCallback(() => {
    mixerRef.current?.stop();
    mixerRef.current = null;
    mixedStreamRef.current = null;
    setActiveSources({ mic: false, display: false });
    setLevels({ mic: 0, display: null });
  }, []);

  const start = useCallback(async () => {
    if (busyRef.current || state !== "idle") return;
    busyRef.current = true;
    setError(null);
    setWarning(null);
    setFinalText("");

    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Audio capture is not supported in this browser.");
      busyRef.current = false;
      return;
    }

    const wantsDisplay = mode !== "mic";

    // === ACTIVATION-ORDER CRITICAL SECTION ==================================
    // Create BOTH acquisition promises synchronously — no await between them.
    // Awaiting the mic prompt before calling getDisplayMedia would consume
    // the transient user activation (InvalidStateError).
    const micPromise = navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true },
    });
    const displayPromise: Promise<MediaStream> | null = wantsDisplay
      ? (
          navigator.mediaDevices as MediaDevices & {
            getDisplayMedia(opts: DisplayMediaOptions): Promise<MediaStream>;
          }
        ).getDisplayMedia(displayOptionsFor(mode))
      : null;
    // ========================================================================

    setState("acquiring");
    const [micRes, displayRes] = await Promise.allSettled([
      micPromise,
      displayPromise ?? Promise.resolve(null),
    ]);

    const micStream = micRes.status === "fulfilled" ? micRes.value : null;
    const displayStream =
      displayRes.status === "fulfilled" ? displayRes.value : null;

    // Partial-failure cleanup: if either acquisition failed, stop all tracks
    // of whichever stream WAS acquired before surfacing the error state.
    if (!micStream || (wantsDisplay && displayRes.status === "rejected")) {
      micStream?.getTracks().forEach((t) => t.stop());
      displayStream?.getTracks().forEach((t) => t.stop());
      setError(!micStream ? ERR_MIC_DENIED : ERR_SHARE_CANCELLED);
      setState("idle");
      busyRef.current = false;
      return;
    }

    // Share granted but WITHOUT the audio checkbox: warn and continue
    // mic-only rather than failing. The display stream is useless for
    // audio-only mixing, so stop all its tracks (incl. video) immediately.
    let displayForMix: MediaStream | undefined;
    if (displayStream) {
      if (displayStream.getAudioTracks().length > 0) {
        displayForMix = displayStream;
      } else {
        displayStream.getTracks().forEach((t) => t.stop());
        setWarning(WARN_NO_TAB_AUDIO);
      }
    }

    const mixer = new CaptureMixer();
    mixer.onSourceEnded((source) => {
      if (source === "display") {
        // Browser "Stop sharing" bar: downgrade to mic-only, keep recording.
        setActiveSources((prev) => ({ ...prev, display: false }));
        setWarning(WARN_SHARE_ENDED);
      } else {
        setActiveSources((prev) => ({ ...prev, mic: false }));
        setWarning("Microphone input ended unexpectedly.");
      }
    });

    let mixed: MediaStream;
    try {
      mixed = await mixer.start({ mic: micStream, display: displayForMix });
    } catch {
      mixer.stop(); // stops the raw tracks it was given ownership of
      setError("Could not start the audio mixer.");
      setState("idle");
      busyRef.current = false;
      return;
    }

    mixerRef.current = mixer;
    mixedStreamRef.current = mixed;
    setActiveSources({ mic: true, display: !!displayForMix });

    // Recorder first: offline durability must not depend on the live path.
    await recorder.start();
    // Live path (non-fatal if it fails — surfaced as a warning via effect).
    soniox.toggleRecording();

    setState("live");
    busyRef.current = false;
  }, [mode, state, recorder, soniox]);

  const stop = useCallback(async () => {
    if (busyRef.current || state !== "live") return;
    busyRef.current = true;
    setState("stopping");

    // Graceful Soniox stop first (SDK flushes buffered audio into finals; the
    // mixer keeps the source tracks alive until the flush completes — see the
    // stopping-state effect below).
    if (soniox.recordState !== "idle") soniox.toggleRecording();

    // Finalize the recording -> onComplete -> IndexedDB queue.
    await recorder.stop();

    // Safety net: if the Soniox flush never completes, force teardown.
    stopFlushTimerRef.current = setTimeout(() => {
      teardownMixer();
      setState("idle");
    }, STOP_FLUSH_TIMEOUT_MS);

    busyRef.current = false;
  }, [state, soniox, recorder, teardownMixer]);

  // Complete the stop once the graceful Soniox flush finishes (recordState
  // returns to idle) — then it is safe to stop the raw source tracks.
  useEffect(() => {
    if (state !== "stopping" || soniox.recordState !== "idle") return;
    if (stopFlushTimerRef.current !== null) {
      clearTimeout(stopFlushTimerRef.current);
      stopFlushTimerRef.current = null;
    }
    teardownMixer();
    setState("idle");
  }, [state, soniox.recordState, teardownMixer]);

  // Surface a live-path failure as a non-fatal warning while capture runs
  // (recording continues; async transcription still happens on stop).
  useEffect(() => {
    if (state === "live" && soniox.micError) {
      setWarning(WARN_LIVE_DOWN);
    }
  }, [state, soniox.micError]);

  // Poll per-channel levels while the mixer is running.
  useEffect(() => {
    if (state !== "live") return;
    const id = setInterval(() => {
      const mixer = mixerRef.current;
      if (mixer) setLevels(mixer.getLevels());
    }, LEVEL_POLL_MS);
    return () => clearInterval(id);
  }, [state]);

  // Unmount: release the mixer + raw tracks (soniox/recorder clean up via
  // their own unmount effects; they never stop the injected stream's tracks).
  useEffect(() => {
    return () => {
      if (stopFlushTimerRef.current !== null) {
        clearTimeout(stopFlushTimerRef.current);
      }
      mixerRef.current?.stop();
      mixerRef.current = null;
      mixedStreamRef.current = null;
    };
  }, []);

  return {
    mode,
    setMode,
    state,
    levels,
    activeSources,
    warning,
    error,
    start,
    stop,
    elapsedMs: recorder.elapsedMs,
    finalText,
    interimText: soniox.interimText,
    support,
  };
}
