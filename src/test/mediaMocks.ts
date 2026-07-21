/**
 * Shared fakes for browser media APIs (MediaStream/track, AudioContext,
 * MediaRecorder) used by the capture tests. jsdom implements none of these.
 */

export class FakeTrack extends EventTarget {
  readonly kind: "audio" | "video";
  stopped = false;
  readyState: "live" | "ended" = "live";

  constructor(kind: "audio" | "video") {
    super();
    this.kind = kind;
  }

  stop(): void {
    this.stopped = true;
    this.readyState = "ended";
    // Note: per spec, calling stop() does NOT fire 'ended' — matches Chrome.
  }

  /** Simulate the browser ending the track (e.g. native Stop-sharing bar). */
  end(): void {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}

export class FakeMediaStream {
  constructor(public tracks: FakeTrack[]) {}
  getTracks(): FakeTrack[] {
    return [...this.tracks];
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === "video");
  }
}

export function micStream(): FakeMediaStream {
  return new FakeMediaStream([new FakeTrack("audio")]);
}

export function displayStream(withAudio = true): FakeMediaStream {
  const tracks: FakeTrack[] = [new FakeTrack("video")];
  if (withAudio) tracks.push(new FakeTrack("audio"));
  return new FakeMediaStream(tracks);
}

/** Byte value FakeAnalyser fills time-domain buffers with (128 = silence). */
export const analyserFill = { value: 128 };

class FakeNode {
  connect(): void {}
  disconnect(): void {}
}

class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  smoothingTimeConstant = 0;
  get frequencyBinCount(): number {
    return this.fftSize / 2;
  }
  getByteTimeDomainData(buf: Uint8Array): void {
    buf.fill(analyserFill.value);
  }
}

export class FakeAudioContext {
  state = "running";
  static instances: FakeAudioContext[] = [];
  closed = false;

  constructor() {
    FakeAudioContext.instances.push(this);
  }
  async resume(): Promise<void> {
    this.state = "running";
  }
  async close(): Promise<void> {
    this.closed = true;
    this.state = "closed";
  }
  createGain(): FakeNode {
    return new FakeNode();
  }
  createAnalyser(): FakeAnalyser {
    return new FakeAnalyser();
  }
  createMediaStreamSource(_stream: unknown): FakeNode {
    return new FakeNode();
  }
  createMediaStreamDestination(): {
    stream: FakeMediaStream;
    disconnect: () => void;
  } {
    return { stream: micStream(), disconnect: () => {} };
  }
}

export class FakeMediaRecorder {
  static isTypeSupported(_type: string): boolean {
    return true;
  }
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm;codecs=opus";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onerror: (() => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(
    public stream: unknown,
    opts?: { mimeType?: string },
  ) {
    if (opts?.mimeType) this.mimeType = opts.mimeType;
  }
  start(_timeslice?: number): void {
    this.state = "recording";
  }
  stop(): void {
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["chunk"], { type: this.mimeType }) });
    this.onstop?.();
  }
}

/** Install AudioContext + MediaRecorder fakes on globalThis. */
export function installMediaGlobals(): void {
  (globalThis as Record<string, unknown>).AudioContext = FakeAudioContext;
  (globalThis as Record<string, unknown>).MediaRecorder = FakeMediaRecorder;
  (window as unknown as Record<string, unknown>).MediaRecorder =
    FakeMediaRecorder;
}

/** Install navigator.mediaDevices with the given implementations. */
export function installMediaDevices(impl: {
  getUserMedia?: (c?: unknown) => Promise<unknown>;
  getDisplayMedia?: (c?: unknown) => Promise<unknown>;
}): void {
  Object.defineProperty(navigator, "mediaDevices", {
    value: impl,
    configurable: true,
    writable: true,
  });
}
