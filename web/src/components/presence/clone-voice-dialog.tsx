"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  createPocketClone,
  decodeAudioToMono,
  float32ToWavBlob,
  getPocketStatus,
  onPocketStatus,
  preloadPocket,
  type PocketLoadStatus,
} from "@/lib/perception/pocket-tts";
import {
  deletePocketClone,
  listPocketClones,
  renamePocketClone,
} from "@/lib/perception/pocket-voice-store";

type CloneMeta = {
  id: string;
  name: string;
  createdAt: number;
  sampleRate: number;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called when user picks a clone for Presence output. */
  onUseForOutput?: (cloneId: string) => void;
};

function formatStatus(s: PocketLoadStatus): string {
  switch (s.state) {
    case "idle":
      return "Not loaded yet";
    case "loading":
      return s.progress != null
        ? `${s.message} (${Math.round(s.progress)}%)`
        : s.message;
    case "ready":
      return s.cloning ? "Ready (cloning enabled)" : "Ready (built-ins)";
    case "error":
      return `Error: ${s.message}`;
  }
}

export function CloneVoiceDialog({
  open,
  onOpenChange,
  onUseForOutput,
}: Props) {
  const [status, setStatus] = useState<PocketLoadStatus>(() =>
    getPocketStatus(),
  );
  const [clones, setClones] = useState<CloneMeta[]>([]);
  const [name, setName] = useState("My voice");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordSecs, setRecordSecs] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [pendingPcm, setPendingPcm] = useState<{
    pcm: Float32Array;
    sampleRate: number;
  } | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refreshClones = useCallback(async () => {
    try {
      const list = await listPocketClones();
      setClones(list);
    } catch (err) {
      console.warn("[clone-voice] list failed", err);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setError(null);
    const unsub = onPocketStatus(setStatus);
    void refreshClones();
    void preloadPocket({ voiceCloning: true }).catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
    return () => {
      unsub();
      stopRecordingInternal();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cleanup preview on close only
  }, [open, refreshClones]);

  function stopRecordingInternal() {
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    const rec = mediaRecorderRef.current;
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {
        // ignore
      }
    }
    mediaRecorderRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setRecording(false);
  }

  function clearPending() {
    setPendingPcm(null);
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
    }
  }

  async function setReferenceFromBlob(blob: Blob) {
    setError(null);
    setBusy(true);
    try {
      const { pcm, sampleRate } = await decodeAudioToMono(blob);
      if (pcm.length < sampleRate * 1.5) {
        throw new Error("Need at least ~2 seconds of clear speech.");
      }
      clearPending();
      setPendingPcm({ pcm, sampleRate });
      const url = URL.createObjectURL(float32ToWavBlob(pcm, sampleRate));
      setPreviewUrl(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function startRecording() {
    setError(null);
    clearPending();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
        },
      });
      streamRef.current = stream;
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "";
      const rec = new MediaRecorder(
        stream,
        mime ? { mimeType: mime } : undefined,
      );
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, {
          type: rec.mimeType || "audio/webm",
        });
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        void setReferenceFromBlob(blob);
      };
      mediaRecorderRef.current = rec;
      rec.start(200);
      setRecording(true);
      setRecordSecs(0);
      recordTimerRef.current = setInterval(() => {
        setRecordSecs((s) => {
          if (s + 1 >= 10) {
            stopRecordingInternal();
            return 10;
          }
          return s + 1;
        });
      }, 1000);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Microphone permission denied or unavailable",
      );
    }
  }

  async function saveClone() {
    if (!pendingPcm) {
      setError("Record or upload a short clip first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await preloadPocket({ voiceCloning: true });
      const rec = await createPocketClone({
        name: name.trim() || "My voice",
        pcm: pendingPcm.pcm,
        sampleRate: pendingPcm.sampleRate,
      });
      clearPending();
      setName("My voice");
      await refreshClones();
      onUseForOutput?.(rec.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeClone(id: string) {
    setBusy(true);
    try {
      await deletePocketClone(id);
      await refreshClones();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function renameClone(id: string, nextName: string) {
    const trimmed = nextName.trim();
    if (!trimmed) return;
    try {
      await renamePocketClone(id, trimmed);
      await refreshClones();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Clone a voice</DialogTitle>
          <DialogDescription>
            Record or upload 5–10 seconds of clear speech. Encoding runs in this
            browser — reference audio never leaves the device. Kyutai Pocket TTS
            weights are CC-BY-4.0.
          </DialogDescription>
        </DialogHeader>

        <p className="text-xs text-muted-foreground">
          Model: {formatStatus(status)}
        </p>

        {error ? (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <section className="space-y-3">
          <h3 className="text-sm font-medium">New clone</h3>
          <label className="block space-y-1 text-sm">
            <span className="text-muted-foreground">Display name</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My voice"
            />
          </label>

          <div className="flex flex-wrap gap-2">
            {!recording ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void startRecording()}
              >
                Record (max 10s)
              </Button>
            ) : (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => stopRecordingInternal()}
              >
                Stop ({recordSecs}s)
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || recording}
              onClick={() => fileInputRef.current?.click()}
            >
              Upload audio
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*,.wav,.mp3,.m4a,.ogg,.webm"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void setReferenceFromBlob(file);
              }}
            />
          </div>

          {previewUrl ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">Preview reference</p>
              <audio controls src={previewUrl} className="w-full" />
            </div>
          ) : null}

          <Button
            type="button"
            disabled={busy || !pendingPcm || recording}
            onClick={() => void saveClone()}
          >
            {busy ? "Working…" : "Save clone & use for output"}
          </Button>
        </section>

        <Separator />

        <section className="space-y-3">
          <h3 className="text-sm font-medium">Saved clones</h3>
          {clones.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No clones yet. Record or upload above.
            </p>
          ) : (
            <ul className="space-y-2">
              {clones.map((c) => (
                <li
                  key={c.id}
                  className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-2 text-sm"
                >
                  <Input
                    className="h-8 min-w-[8rem] flex-1"
                    defaultValue={c.name}
                    onBlur={(e) => {
                      if (e.target.value.trim() !== c.name) {
                        void renameClone(c.id, e.target.value);
                      }
                    }}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      onUseForOutput?.(c.id);
                      onOpenChange(false);
                    }}
                  >
                    Use
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void removeClone(c.id)}
                  >
                    Delete
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="flex justify-end pt-1">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
