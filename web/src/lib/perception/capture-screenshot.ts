/**
 * One-shot desktop / window / tab capture via getDisplayMedia.
 * Stops the share tracks immediately after grabbing a JPEG frame.
 */

export type ScreenshotCapture = {
  ok: boolean;
  description?: string;
  dataUrl?: string;
  width?: number;
  height?: number;
};

const MAX_WIDTH = 1280;

export async function captureScreenshotFrame(
  reason?: string,
): Promise<ScreenshotCapture> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getDisplayMedia) {
    return {
      ok: false,
      description: "Screen capture is not supported in this browser.",
    };
  }

  let stream: MediaStream | null = null;
  let grabVideo: HTMLVideoElement | null = null;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 5 },
        width: { ideal: MAX_WIDTH },
      },
      audio: false,
    });

    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    // Detached videos often stay black until attached (macOS display capture).
    video.dataset.hearsayScreenGrab = "1";
    video.setAttribute("aria-hidden", "true");
    video.style.cssText =
      "position:fixed;left:-9999px;width:160px;height:90px;opacity:0;pointer-events:none";
    grabVideo = video;
    document.body.appendChild(video);
    await video.play();
    await waitForPresentedFrame(video);

    const srcW = video.videoWidth;
    const srcH = video.videoHeight;
    if (!srcW || !srcH) {
      return { ok: false, description: "Screen share has no video dimensions." };
    }

    const scale = srcW > MAX_WIDTH ? MAX_WIDTH / srcW : 1;
    const width = Math.round(srcW * scale);
    const height = Math.round(srcH * scale);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")?.drawImage(video, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.82);

    return {
      ok: true,
      description: reason
        ? `Screenshot captured (${reason})`
        : "Screenshot captured",
      dataUrl,
      width,
      height,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const denied =
      /NotAllowedError|Permission denied|dismissed/i.test(message) ||
      (err instanceof DOMException && err.name === "NotAllowedError");
    return {
      ok: false,
      description: denied
        ? "Screen share was cancelled or blocked. Allow screen/window capture when prompted."
        : `Screenshot failed: ${message}`,
    };
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
    grabVideo?.remove();
  }
}

/**
 * Display capture's first presented frame is often solid black.
 * Wait until a frame has real pixels, or give up after ~1.5s.
 */
function waitForPresentedFrame(video: HTMLVideoElement): Promise<void> {
  const deadline = performance.now() + 1500;
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const step = () => {
      if (settled) return;
      if (video.videoWidth > 0 && !isBlankFrame(video)) {
        finish();
        return;
      }
      if (performance.now() >= deadline) {
        finish();
        return;
      }
      window.setTimeout(step, 80);
    };
    step();
  });
}

function isBlankFrame(video: HTMLVideoElement): boolean {
  const w = 32;
  const h = 18;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx || !video.videoWidth) return true;
  ctx.drawImage(video, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  let sum = 0;
  const pixels = data.length / 4;
  for (let i = 0; i < data.length; i += 16) {
    sum += (data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0);
  }
  const samples = Math.ceil(pixels / 4);
  const avg = sum / samples / 3;
  // Uninitialized frames are ~0. Dark UIs still have text above this.
  return avg < 3;
}
