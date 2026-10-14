/**
 * Vision sampler — present for Step B, disabled in Step A.
 * Captures ~1 fps JPEG when enableVision is true; drops if in-flight.
 */
export type FrameGrabberOptions = {
  video: HTMLVideoElement;
  enableVision?: boolean;
  intervalMs?: number;
  quality?: number;
  width?: number;
  height?: number;
  onFrame: (dataUrl: string, meta: { width: number; height: number }) => void;
};

export class FrameGrabber {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private canvas: HTMLCanvasElement | null = null;
  private discardedFirst = false;

  constructor(private readonly opts: FrameGrabberOptions) {}

  start(): void {
    if (!this.opts.enableVision) return;
    this.stop();
    this.discardedFirst = false;
    const interval = this.opts.intervalMs ?? 1000;
    this.timer = setInterval(() => this.tick(), interval);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.inFlight = false;
  }

  private tick(): void {
    if (this.inFlight || !this.opts.enableVision) return;
    const video = this.opts.video;
    if (!video.videoWidth) return;

    // Camera auto-exposure: discard first frame
    if (!this.discardedFirst) {
      this.discardedFirst = true;
      return;
    }

    this.inFlight = true;
    try {
      const w = this.opts.width ?? 640;
      const h = this.opts.height ?? 352;
      if (!this.canvas) this.canvas = document.createElement("canvas");
      this.canvas.width = w;
      this.canvas.height = h;
      const ctx = this.canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, w, h);
      const dataUrl = this.canvas.toDataURL(
        "image/jpeg",
        this.opts.quality ?? 0.7,
      );
      this.opts.onFrame(dataUrl, { width: w, height: h });
    } finally {
      this.inFlight = false;
    }
  }
}
