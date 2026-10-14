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
    await video.play();
    // Wait for real dimensions (first frame)
    await waitForVideoFrame(video);

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
  }
}

function waitForVideoFrame(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    if (video.videoWidth > 0) {
      resolve();
      return;
    }
    const onMeta = () => {
      cleanup();
      // One paint after metadata
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    };
    const timer = window.setTimeout(() => {
      cleanup();
      resolve();
    }, 1500);
    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener("loadeddata", onMeta);
      video.removeEventListener("loadedmetadata", onMeta);
    };
    video.addEventListener("loadeddata", onMeta);
    video.addEventListener("loadedmetadata", onMeta);
  });
}
