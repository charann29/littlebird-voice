/**
 * CaptureMixer — WebAudio mixing layer for Meeting capture (plan 40 Track A).
 *
 * Composes the microphone stream and (optionally) a getDisplayMedia stream's
 * audio into ONE audio-only MediaStream that is handed to BOTH the live
 * Soniox path (useSoniox) and the offline MediaRecorder queue path
 * (useRecorder), so live transcription and the durable recording always
 * contain identical audio.
 *
 * Graph (mirrors the WaveformViz class style):
 *
 *   mic     -> MediaStreamSource -> GainNode -> MediaStreamAudioDestination
 *                              \-> AnalyserNode (mic level)
 *   display -> MediaStreamSource -> GainNode -> MediaStreamAudioDestination
 *                              \-> AnalyserNode (display level)
 *
 * STREAM OWNERSHIP RULE: whoever creates a MediaStream stops it. The mixer is
 * given ownership of the raw mic + display streams (including the unused
 * display VIDEO track, which must be kept alive — stopping it can end the
 * capture session) and stops them all in stop(). Consumers of the mixed
 * stream (useSoniox / useRecorder with an injected stream) must never call
 * track.stop() on either the mixed stream or the raw streams.
 */

export type CaptureSourceName = "mic" | "display";

export interface CaptureLevels {
  /** RMS 0..1 of the mic branch. */
  mic: number;
  /** RMS 0..1 of the display branch, or null when no display audio is mixed. */
  display: number | null;
}

/**
 * getDisplayMedia options including Chromium dictionary members that are not
 * (all) in lib.dom yet. These are HINTS ONLY — the browser's share picker is
 * always authoritative; a mode can never force or restrict the user's choice.
 */
export interface DisplayMediaOptions {
  /** Chrome requires video to be requested even for audio-only mixing. */
  video: boolean | MediaTrackConstraints;
  audio?: boolean | MediaTrackConstraints;
  preferCurrentTab?: boolean;
  selfBrowserSurface?: "include" | "exclude";
  systemAudio?: "include" | "exclude";
  surfaceSwitching?: "include" | "exclude";
  monitorTypeSurfaces?: "include" | "exclude";
}

export interface CaptureSupport {
  /** True when getDisplayMedia audio capture is plausible (desktop Chromium). */
  tabAudio: boolean;
  /**
   * System/whole-screen audio is only offered by Chromium on Windows and
   * ChromeOS. On macOS/Linux only tab audio works; elsewhere nothing does.
   */
  systemAudio: "windows-chromeos" | false;
}

/**
 * Capability probe for the mixed capture modes. Display-surface AUDIO capture
 * is a desktop-Chromium-only feature (Firefox: unsupported; Safari: API
 * exists but never returns audio; mobile: unsupported entirely), so the
 * detection is getDisplayMedia presence + a Chromium UA heuristic.
 */
export function getCaptureSupport(): CaptureSupport {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  const ua = nav?.userAgent ?? "";
  const hasApi = typeof nav?.mediaDevices?.getDisplayMedia === "function";
  const isChromium = /Chrom(e|ium)/.test(ua);
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  const tabAudio = hasApi && isChromium && !isMobile;
  const onWindowsOrCrOS = /Windows NT|CrOS/.test(ua);
  return {
    tabAudio,
    systemAudio: tabAudio && onWindowsOrCrOS ? "windows-chromeos" : false,
  };
}

/** Per-source branch of the mix graph. */
interface SourceBranch {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  analyser: AnalyserNode;
  buf: Uint8Array<ArrayBuffer>;
}

const ANALYSER_FFT_SIZE = 256;

export class CaptureMixer {
  private ctx: AudioContext | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private mic: SourceBranch | null = null;
  private display: SourceBranch | null = null;
  /** Raw streams the mixer OWNS and must stop on stop(). */
  private micStream: MediaStream | null = null;
  /** Full display stream incl. the unused-but-kept-alive video track. */
  private displayStream: MediaStream | null = null;
  private endedCb: ((source: CaptureSourceName) => void) | null = null;
  private displayEndedFired = false;
  private micEndedFired = false;
  private stopped = false;
  private trackListeners: Array<{
    track: MediaStreamTrack;
    listener: () => void;
  }> = [];

  /**
   * Build the mix graph and return the mixed audio-only MediaStream. The
   * mixer takes OWNERSHIP of both given streams (see ownership rule above).
   * `display` should only be passed when it actually has audio tracks.
   */
  async start(sources: {
    mic: MediaStream;
    display?: MediaStream;
  }): Promise<MediaStream> {
    if (this.ctx) throw new Error("CaptureMixer already started");
    const ctx = new AudioContext();
    this.ctx = ctx;
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
    this.dest = ctx.createMediaStreamDestination();

    this.micStream = sources.mic;
    this.mic = this.attach(sources.mic);
    for (const track of sources.mic.getAudioTracks()) {
      this.listenEnded(track, () => this.handleMicEnded());
    }

    if (sources.display) {
      this.displayStream = sources.display;
      if (sources.display.getAudioTracks().length > 0) {
        this.display = this.attach(sources.display);
      }
      // The browser's native "Stop sharing" bar fires `ended` on the display
      // tracks (video and/or audio) — watch ALL of them.
      for (const track of sources.display.getTracks()) {
        this.listenEnded(track, () => this.handleDisplayEnded());
      }
    }

    return this.dest.stream;
  }

  /** Wire a callback for a raw source ending outside our control. */
  onSourceEnded(cb: (source: CaptureSourceName) => void): void {
    this.endedCb = cb;
  }

  /**
   * RMS levels (0..1) per pre-mix branch, polled by the UI at an interval.
   * `display` is null when no display audio is (any longer) mixed.
   */
  getLevels(): CaptureLevels {
    return {
      mic: this.mic ? rms(this.mic) : 0,
      display: this.display ? rms(this.display) : null,
    };
  }

  /**
   * Tear everything down: disconnect nodes, close the AudioContext, and stop
   * every raw source track the mixer owns — including the unused display
   * VIDEO track. The mixed stream's consumers never stop tracks themselves.
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const { track, listener } of this.trackListeners) {
      track.removeEventListener("ended", listener);
    }
    this.trackListeners = [];
    this.detachBranch(this.mic);
    this.detachBranch(this.display);
    this.mic = null;
    this.display = null;
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    this.displayStream?.getTracks().forEach((t) => t.stop());
    this.displayStream = null;
    this.dest?.disconnect();
    this.dest = null;
    void this.ctx?.close();
    this.ctx = null;
    this.endedCb = null;
  }

  // ---------------------------------------------------------------- private

  private attach(stream: MediaStream): SourceBranch {
    const ctx = this.ctx!;
    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = ANALYSER_FFT_SIZE;
    source.connect(gain);
    gain.connect(this.dest!);
    source.connect(analyser);
    return {
      stream,
      source,
      gain,
      analyser,
      buf: new Uint8Array(analyser.frequencyBinCount),
    };
  }

  private detachBranch(branch: SourceBranch | null): void {
    if (!branch) return;
    branch.source.disconnect();
    branch.gain.disconnect();
    branch.analyser.disconnect();
  }

  private listenEnded(track: MediaStreamTrack, listener: () => void): void {
    track.addEventListener("ended", listener);
    this.trackListeners.push({ track, listener });
  }

  /**
   * User hit the browser's "Stop sharing" bar (or the surface went away):
   * downgrade to mic-only — detach and stop the display branch, keep the mic
   * branch (and therefore the mixed stream + recording) alive, notify the UI.
   */
  private handleDisplayEnded(): void {
    if (this.stopped || this.displayEndedFired) return;
    this.displayEndedFired = true;
    this.detachBranch(this.display);
    this.display = null;
    this.displayStream?.getTracks().forEach((t) => t.stop());
    this.displayStream = null;
    this.endedCb?.("display");
  }

  private handleMicEnded(): void {
    if (this.stopped || this.micEndedFired) return;
    this.micEndedFired = true;
    this.endedCb?.("mic");
  }
}

/** RMS 0..1 from an analyser's byte time-domain data. */
function rms(branch: SourceBranch): number {
  branch.analyser.getByteTimeDomainData(branch.buf);
  let sum = 0;
  for (let i = 0; i < branch.buf.length; i++) {
    const v = (branch.buf[i]! - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / branch.buf.length));
}
