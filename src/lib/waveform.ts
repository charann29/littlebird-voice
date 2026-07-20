/**
 * Shared live-waveform renderer, extracted from the reference speech-react
 * implementation so both the realtime (useSoniox) and offline recorder
 * (useRecorder) hooks share one visualization technique.
 *
 * A WaveformViz owns an AudioContext + AnalyserNode fed by a MediaStream, and
 * draws a scrolling time-domain wave onto a canvas via requestAnimationFrame.
 */

const WAVEFORM_LENGTH = 160;
const SAMPLES_PER_TICK = 3;

export type WaveColor = "listening" | "connecting";

const COLORS: Record<WaveColor, { fill: string; stroke: string }> = {
  listening: { fill: "rgba(34,197,94,0.1)", stroke: "#22c55e" }, // green-500
  connecting: { fill: "rgba(234,179,8,0.1)", stroke: "#eab308" }, // yellow-500
};

export class WaveformViz {
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private animationId: number | null = null;
  private data: number[] = Array(WAVEFORM_LENGTH).fill(0);
  private colorRef: () => WaveColor;

  constructor(
    private canvasRef: { current: HTMLCanvasElement | null },
    colorRef: () => WaveColor = () => "listening",
  ) {
    this.colorRef = colorRef;
  }

  /**
   * Attach to a MediaStream and begin animating. The AudioContext is created
   * here (inside a user-gesture-triggered call path) and resumed if suspended.
   */
  async start(stream: MediaStream): Promise<void> {
    this.audioCtx = new AudioContext();
    if (this.audioCtx.state === "suspended") {
      await this.audioCtx.resume();
    }
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 128;
    this.analyser.smoothingTimeConstant = 0.55;
    this.source = this.audioCtx.createMediaStreamSource(stream);
    this.source.connect(this.analyser);

    const buf = new Uint8Array(this.analyser.frequencyBinCount);
    const tick = () => {
      this.animationId = requestAnimationFrame(tick);
      if (!this.analyser) return;
      this.analyser.getByteTimeDomainData(buf);
      const vals: number[] = [];
      for (let i = 0; i < SAMPLES_PER_TICK; i++) {
        const idx = Math.floor((i / SAMPLES_PER_TICK) * buf.length);
        vals.push((buf[idx]! - 128) / 128);
      }
      this.data = [...this.data.slice(SAMPLES_PER_TICK), ...vals];
      this.draw();
    };
    tick();
  }

  private draw(): void {
    const canvas = this.canvasRef.current;
    if (!canvas) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const midY = h / 2;
    const data = this.data;
    const len = data.length;
    const step = w / (len - 1);
    const { fill, stroke } = COLORS[this.colorRef()];

    ctx.beginPath();
    ctx.moveTo(0, midY);
    for (let i = 0; i < len; i++) {
      ctx.lineTo(i * step, midY - data[i]! * midY * 0.85);
    }
    ctx.lineTo(w, midY);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < len; i++) {
      const y = midY - data[i]! * midY * 0.85;
      if (i === 0) ctx.moveTo(0, y);
      else ctx.lineTo(i * step, y);
    }
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  /** Stop animating and release audio nodes. Does NOT stop the MediaStream. */
  stop(): void {
    if (this.animationId !== null) cancelAnimationFrame(this.animationId);
    this.source?.disconnect();
    this.analyser?.disconnect();
    void this.audioCtx?.close();
    this.audioCtx = null;
    this.analyser = null;
    this.source = null;
    this.animationId = null;
    this.data = Array(WAVEFORM_LENGTH).fill(0);
  }
}
