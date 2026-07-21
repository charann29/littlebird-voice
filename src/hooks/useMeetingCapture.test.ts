import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeMediaStream,
  displayStream,
  installMediaDevices,
  installMediaGlobals,
  micStream,
} from "../test/mediaMocks";

// Keep the orchestrator's collaborators controllable: the live Soniox path
// (WebSocket SDK) is faked; recorder + mixer run against the media fakes.
const addFromBlob = vi.fn(async () => ({}) as never);
vi.mock("./useRecordings", () => ({
  useRecordings: () => ({ addFromBlob }),
}));

const sonioxState = {
  recordState: "idle" as "idle" | "connecting" | "listening",
  micError: "",
};
const toggleRecording = vi.fn();
vi.mock("./useSoniox", () => ({
  useSoniox: () => ({
    recordState: sonioxState.recordState,
    isRecording: sonioxState.recordState === "listening",
    isConnecting: sonioxState.recordState === "connecting",
    interimText: "",
    micError: sonioxState.micError,
    toggleRecording,
    cancelRecording: vi.fn(),
  }),
}));

import {
  ERR_MIC_DENIED,
  ERR_SHARE_CANCELLED,
  WARN_NO_TAB_AUDIO,
  WARN_SHARE_ENDED,
  useMeetingCapture,
} from "./useMeetingCapture";

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const canvasRef = { current: null };

function render() {
  return renderHook(() => useMeetingCapture(canvasRef));
}

beforeEach(() => {
  installMediaGlobals();
  Object.defineProperty(navigator, "userAgent", {
    value: CHROME_MAC,
    configurable: true,
  });
  sonioxState.recordState = "idle";
  sonioxState.micError = "";
  addFromBlob.mockClear();
  toggleRecording.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useMeetingCapture", () => {
  it("defaults to tab mode on supporting browsers and starts idle", () => {
    installMediaDevices({ getDisplayMedia: async () => displayStream() });
    const { result } = render();
    expect(result.current.mode).toBe("tab");
    expect(result.current.state).toBe("idle");
    expect(result.current.support.tabAudio).toBe(true);
  });

  it("creates the getDisplayMedia promise synchronously with getUserMedia (activation order)", async () => {
    const order: string[] = [];
    let resolveMic!: (s: unknown) => void;
    const getUserMedia = vi.fn(() => {
      order.push("mic-called");
      return new Promise((res) => {
        resolveMic = res;
      });
    });
    const getDisplayMedia = vi.fn(() => {
      order.push("display-called");
      return Promise.resolve(displayStream());
    });
    installMediaDevices({ getUserMedia, getDisplayMedia });

    const { result } = render();
    let startPromise!: Promise<void>;
    act(() => {
      startPromise = result.current.start();
    });
    // getDisplayMedia must have been invoked BEFORE the mic promise resolves —
    // i.e. synchronously in the same click handler, never awaited after mic.
    expect(order).toEqual(["mic-called", "display-called"]);

    resolveMic(micStream());
    await act(async () => {
      await startPromise;
    });
    expect(result.current.state).toBe("live");
    expect(result.current.activeSources).toEqual({ mic: true, display: true });
    expect(toggleRecording).toHaveBeenCalledTimes(1);
  });

  it("mic denied: stops the acquired display tracks and surfaces the error", async () => {
    const display = displayStream();
    installMediaDevices({
      getUserMedia: async () => {
        throw new DOMException("denied", "NotAllowedError");
      },
      getDisplayMedia: async () => display,
    });
    const { result } = render();
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state).toBe("idle");
    expect(result.current.error).toBe(ERR_MIC_DENIED);
    expect(display.getTracks().every((t) => t.stopped)).toBe(true);
  });

  it("share cancelled: stops the acquired mic tracks and surfaces the error", async () => {
    const mic = micStream();
    installMediaDevices({
      getUserMedia: async () => mic,
      getDisplayMedia: async () => {
        throw new DOMException("cancelled", "NotAllowedError");
      },
    });
    const { result } = render();
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state).toBe("idle");
    expect(result.current.error).toBe(ERR_SHARE_CANCELLED);
    expect(mic.getTracks().every((t) => t.stopped)).toBe(true);
  });

  it("share without audio: continues mic-only with a warning; display tracks stopped", async () => {
    const display = displayStream(false); // video only, no audio checkbox
    installMediaDevices({
      getUserMedia: async () => micStream(),
      getDisplayMedia: async () => display,
    });
    const { result } = render();
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state).toBe("live");
    expect(result.current.warning).toBe(WARN_NO_TAB_AUDIO);
    expect(result.current.activeSources).toEqual({ mic: true, display: false });
    expect(display.getTracks().every((t) => t.stopped)).toBe(true);
  });

  it("browser Stop-sharing mid-session: downgrades to mic-only with a warning, keeps recording", async () => {
    const display = displayStream();
    installMediaDevices({
      getUserMedia: async () => micStream(),
      getDisplayMedia: async () => display,
    });
    const { result } = render();
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.activeSources.display).toBe(true);

    act(() => {
      display.getVideoTracks()[0]!.end();
      display.getAudioTracks()[0]!.end();
    });
    expect(result.current.state).toBe("live"); // recording continues
    expect(result.current.activeSources).toEqual({ mic: true, display: false });
    expect(result.current.warning).toBe(WARN_SHARE_ENDED);
  });

  it("mic-only mode never calls getDisplayMedia", async () => {
    const getDisplayMedia = vi.fn(async () => displayStream());
    installMediaDevices({
      getUserMedia: async () => micStream(),
      getDisplayMedia,
    });
    const { result } = render();
    act(() => {
      result.current.setMode("mic");
    });
    await act(async () => {
      await result.current.start();
    });
    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(result.current.state).toBe("live");
    expect(result.current.activeSources).toEqual({ mic: true, display: false });
  });

  it("stop(): finalizes the recording into addFromBlob, then stops raw tracks after the soniox flush", async () => {
    const mic = micStream();
    const display = displayStream();
    installMediaDevices({
      getUserMedia: async () => mic,
      getDisplayMedia: async () => display,
    });
    const { result } = render();
    await act(async () => {
      await result.current.start();
    });
    sonioxState.recordState = "listening";

    await act(async () => {
      await result.current.stop();
    });
    // Recorder finalize -> onComplete -> addFromBlob (IndexedDB queue path).
    expect(addFromBlob).toHaveBeenCalledTimes(1);
    // Graceful soniox stop was requested; flush not yet finished.
    expect(result.current.state).toBe("stopping");
    expect(mic.getAudioTracks()[0]!.stopped).toBe(false);

    // Soniox flush completes (recordState back to idle) -> teardown.
    sonioxState.recordState = "idle";
    act(() => {
      // trigger a re-render so the stopping-state effect re-evaluates
      // (a DIFFERENT mode value — same-value setState bails out of rendering)
      result.current.setMode("screen");
    });
    await waitFor(() => expect(result.current.state).toBe("idle"));
    expect(mic.getTracks().every((t) => t.stopped)).toBe(true);
    expect(display.getTracks().every((t) => t.stopped)).toBe(true);
  });

  it("unmount while live stops all raw tracks (mixer ownership)", async () => {
    const mic = micStream();
    const display = displayStream();
    installMediaDevices({
      getUserMedia: async () => mic,
      getDisplayMedia: async () => display,
    });
    const { result, unmount } = render();
    await act(async () => {
      await result.current.start();
    });
    unmount();
    expect(mic.getTracks().every((t) => t.stopped)).toBe(true);
    expect(display.getTracks().every((t) => t.stopped)).toBe(true);
  });

  it("injected getStream hands the recorder the mixed stream (never raw sources)", async () => {
    const recorderStreams: unknown[] = [];
    const OrigRecorder = (globalThis as Record<string, unknown>)
      .MediaRecorder as new (s: unknown, o?: unknown) => unknown;
    class SpyRecorder extends (OrigRecorder as new (
      s: unknown,
      o?: unknown,
    ) => object) {
      constructor(s: unknown, o?: unknown) {
        super(s, o);
        recorderStreams.push(s);
      }
      static isTypeSupported(): boolean {
        return true;
      }
    }
    (globalThis as Record<string, unknown>).MediaRecorder = SpyRecorder;
    (window as unknown as Record<string, unknown>).MediaRecorder = SpyRecorder;

    const mic = micStream();
    installMediaDevices({
      getUserMedia: async () => mic,
      getDisplayMedia: async () => displayStream(),
    });
    const { result } = render();
    await act(async () => {
      await result.current.start();
    });
    expect(recorderStreams).toHaveLength(1);
    // The recorder got the mixer's destination stream, not the raw mic.
    expect(recorderStreams[0]).not.toBe(mic);
    expect(recorderStreams[0]).toBeInstanceOf(FakeMediaStream);
  });
});
