import { beforeEach, describe, expect, it, vi } from "vitest";
import { CaptureMixer, getCaptureSupport } from "./captureMixer";
import {
  FakeAudioContext,
  FakeMediaStream,
  analyserFill,
  displayStream,
  installMediaGlobals,
  micStream,
} from "../test/mediaMocks";

function setUserAgent(ua: string): void {
  Object.defineProperty(navigator, "userAgent", {
    value: ua,
    configurable: true,
  });
}

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const CHROME_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const FIREFOX =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0";
const SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

function installGetDisplayMedia(present: boolean): void {
  Object.defineProperty(navigator, "mediaDevices", {
    value: present ? { getDisplayMedia: () => Promise.resolve() } : {},
    configurable: true,
    writable: true,
  });
}

describe("getCaptureSupport", () => {
  it("enables tab audio (not system audio) on desktop Chrome/macOS", () => {
    setUserAgent(CHROME_MAC);
    installGetDisplayMedia(true);
    expect(getCaptureSupport()).toEqual({ tabAudio: true, systemAudio: false });
  });

  it("enables system audio on Chrome/Windows", () => {
    setUserAgent(CHROME_WIN);
    installGetDisplayMedia(true);
    expect(getCaptureSupport()).toEqual({
      tabAudio: true,
      systemAudio: "windows-chromeos",
    });
  });

  it.each([
    ["Firefox", FIREFOX],
    ["Safari", SAFARI],
    ["mobile Chrome", CHROME_ANDROID],
  ])("disables mixed modes on %s", (_name, ua) => {
    setUserAgent(ua);
    installGetDisplayMedia(true);
    expect(getCaptureSupport()).toEqual({ tabAudio: false, systemAudio: false });
  });

  it("disables mixed modes when getDisplayMedia is missing", () => {
    setUserAgent(CHROME_MAC);
    installGetDisplayMedia(false);
    expect(getCaptureSupport()).toEqual({ tabAudio: false, systemAudio: false });
  });
});

describe("CaptureMixer", () => {
  beforeEach(() => {
    installMediaGlobals();
    FakeAudioContext.instances = [];
    analyserFill.value = 128;
  });

  it("returns a mixed stream and reports per-source levels", async () => {
    const mixer = new CaptureMixer();
    const mixed = await mixer.start({
      mic: micStream() as unknown as MediaStream,
      display: displayStream() as unknown as MediaStream,
    });
    expect(mixed).toBeInstanceOf(FakeMediaStream);

    // Silence (byte 128) -> RMS 0 on both channels.
    expect(mixer.getLevels()).toEqual({ mic: 0, display: 0 });

    // Non-silent data -> non-zero RMS.
    analyserFill.value = 255;
    const levels = mixer.getLevels();
    expect(levels.mic).toBeGreaterThan(0.5);
    expect(levels.display).toBeGreaterThan(0.5);
    mixer.stop();
  });

  it("reports display: null when started mic-only", async () => {
    const mixer = new CaptureMixer();
    await mixer.start({ mic: micStream() as unknown as MediaStream });
    expect(mixer.getLevels().display).toBeNull();
    mixer.stop();
  });

  it("stop() stops ALL raw source tracks incl. the unused display video track", async () => {
    const mic = micStream();
    const display = displayStream();
    const mixer = new CaptureMixer();
    await mixer.start({
      mic: mic as unknown as MediaStream,
      display: display as unknown as MediaStream,
    });

    // Mixer keeps the display video track alive while running.
    expect(display.getVideoTracks()[0]!.stopped).toBe(false);

    mixer.stop();
    expect(mic.getTracks().every((t) => t.stopped)).toBe(true);
    expect(display.getTracks().every((t) => t.stopped)).toBe(true);
    expect(FakeAudioContext.instances[0]!.closed).toBe(true);
  });

  it("fires onSourceEnded('display') once and downgrades to mic-only on Stop sharing", async () => {
    const mic = micStream();
    const display = displayStream();
    const mixer = new CaptureMixer();
    await mixer.start({
      mic: mic as unknown as MediaStream,
      display: display as unknown as MediaStream,
    });
    const cb = vi.fn();
    mixer.onSourceEnded(cb);

    // Browser "Stop sharing" ends both display tracks.
    display.getVideoTracks()[0]!.end();
    display.getAudioTracks()[0]!.end();

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith("display");
    // Display branch stopped + level channel goes null; mic keeps flowing.
    expect(display.getTracks().every((t) => t.stopped)).toBe(true);
    expect(mixer.getLevels().display).toBeNull();
    expect(mic.getAudioTracks()[0]!.stopped).toBe(false);
    mixer.stop();
  });

  it("fires onSourceEnded('mic') when the mic track ends", async () => {
    const mic = micStream();
    const mixer = new CaptureMixer();
    await mixer.start({ mic: mic as unknown as MediaStream });
    const cb = vi.fn();
    mixer.onSourceEnded(cb);
    mic.getAudioTracks()[0]!.end();
    expect(cb).toHaveBeenCalledWith("mic");
    mixer.stop();
  });

  it("does not attach a display branch for a zero-audio-track display stream", async () => {
    const mixer = new CaptureMixer();
    await mixer.start({
      mic: micStream() as unknown as MediaStream,
      display: displayStream(false) as unknown as MediaStream,
    });
    expect(mixer.getLevels().display).toBeNull();
    mixer.stop();
  });

  it("stop() is idempotent and start() cannot be called twice", async () => {
    const mixer = new CaptureMixer();
    await mixer.start({ mic: micStream() as unknown as MediaStream });
    await expect(
      mixer.start({ mic: micStream() as unknown as MediaStream }),
    ).rejects.toThrow(/already started/);
    mixer.stop();
    expect(() => mixer.stop()).not.toThrow();
  });
});
