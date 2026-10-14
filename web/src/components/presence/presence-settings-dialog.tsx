"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import type { ServerHelloInfo } from "@/lib/perception/protocol";
import {
  getKokoroStatus,
  KOKORO_VOICES,
  onKokoroStatus,
  preloadKokoro,
  type KokoroLoadStatus,
} from "@/lib/perception/kokoro-tts";
import {
  listSpeechVoices,
  loadPresenceSettings,
  pickDefaultVoice,
  savePresenceSettings,
  type PresenceSettings,
} from "@/lib/perception/presence-settings";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverInfo: ServerHelloInfo | null;
  onSaved?: (settings: PresenceSettings) => void;
};

function formatKokoroStatus(s: KokoroLoadStatus): string {
  switch (s.state) {
    case "idle":
      return "Not loaded yet";
    case "loading":
      return s.progress != null
        ? `${s.message} (${Math.round(s.progress)}%)`
        : s.message;
    case "ready":
      return `Ready (${s.device})`;
    case "error":
      return `Error: ${s.message}`;
  }
}

export function PresenceSettingsDialog({
  open,
  onOpenChange,
  serverInfo,
  onSaved,
}: Props) {
  const [settings, setSettings] = useState<PresenceSettings>(() =>
    loadPresenceSettings(),
  );
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [kokoroStatus, setKokoroStatus] = useState<KokoroLoadStatus>(() =>
    getKokoroStatus(),
  );
  const [loadingKokoro, setLoadingKokoro] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSettings(loadPresenceSettings());
    const refresh = () => {
      const list = listSpeechVoices();
      setVoices(list);
      setSettings((prev) => {
        if (prev.voiceURI || !list.length) return prev;
        const best = pickDefaultVoice(list);
        return best ? { ...prev, voiceURI: best.voiceURI } : prev;
      });
    };
    refresh();
    window.speechSynthesis?.addEventListener("voiceschanged", refresh);
    const unsub = onKokoroStatus(setKokoroStatus);
    return () => {
      window.speechSynthesis?.removeEventListener("voiceschanged", refresh);
      unsub();
    };
  }, [open]);

  function save() {
    savePresenceSettings(settings);
    onSaved?.(settings);
    onOpenChange(false);
  }

  async function loadKokoroModel() {
    setLoadingKokoro(true);
    try {
      await preloadKokoro();
    } catch {
      // status listener surfaces error
    } finally {
      setLoadingKokoro(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Presence settings</DialogTitle>
          <DialogDescription>
            Client prefs are saved in this browser. Server modes come from
            perception <code className="text-xs">hello_ack</code> — restart
            perception after changing <code className="text-xs">.env</code>.
          </DialogDescription>
        </DialogHeader>

        <section className="space-y-3">
          <h3 className="text-sm font-medium">Connection</h3>
          <label className="block space-y-1 text-sm">
            <span className="text-muted-foreground">Perception WS URL</span>
            <Input
              value={settings.wsUrl}
              onChange={(e) =>
                setSettings((s) => ({ ...s, wsUrl: e.target.value }))
              }
              placeholder="ws://localhost:4112"
            />
          </label>
        </section>

        <Separator />

        <section className="space-y-3">
          <h3 className="text-sm font-medium">Speech &amp; TTS</h3>
          <p className="text-xs text-muted-foreground">
            Applies when the server uses <code>TTS_MODE=browser</code> (
            <code>tts_text</code>). Or use a Kokoro HTTP sidecar with{" "}
            <code>TTS_MODE=http</code>.
          </p>
          <label className="block space-y-1 text-sm">
            <span className="text-muted-foreground">Browser TTS engine</span>
            <Select
              value={settings.browserTtsEngine}
              onValueChange={(v) =>
                setSettings((s) => ({
                  ...s,
                  browserTtsEngine:
                    v === "kokoro" ? "kokoro" : "speechSynthesis",
                }))
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="speechSynthesis">
                  System voice (SpeechSynthesis)
                </SelectItem>
                <SelectItem value="kokoro">
                  Kokoro in-browser (neural, on-device)
                </SelectItem>
              </SelectContent>
            </Select>
          </label>

          {settings.browserTtsEngine === "kokoro" ? (
            <>
              <label className="block space-y-1 text-sm">
                <span className="text-muted-foreground">Kokoro voice</span>
                <Select
                  value={settings.kokoroVoice}
                  onValueChange={(kokoroVoice) =>
                    setSettings((s) => ({ ...s, kokoroVoice }))
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {KOKORO_VOICES.map((v) => (
                      <SelectItem key={v.id} value={v.id}>
                        {v.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <p className="text-xs text-muted-foreground">
                Status: {formatKokoroStatus(kokoroStatus)}. First use downloads
                model weights (~100–300MB) and keeps them in the browser cache
                (same idea as{" "}
                <a
                  className="underline"
                  href="https://kokoroweb.app/"
                  target="_blank"
                  rel="noreferrer"
                >
                  kokoroweb.app
                </a>
                ). Prefer Chrome/Edge with WebGPU.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={loadingKokoro || kokoroStatus.state === "ready"}
                onClick={() => void loadKokoroModel()}
              >
                {kokoroStatus.state === "ready"
                  ? "Kokoro ready"
                  : loadingKokoro
                    ? "Loading…"
                    : "Load Kokoro model"}
              </Button>
            </>
          ) : (
            <label className="block space-y-1 text-sm">
              <span className="text-muted-foreground">System voice</span>
              <Select
                value={settings.voiceURI || undefined}
                onValueChange={(voiceURI) =>
                  setSettings((s) => ({ ...s, voiceURI }))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Default system voice" />
                </SelectTrigger>
                <SelectContent>
                  {voices.map((v) => (
                    <SelectItem key={v.voiceURI} value={v.voiceURI}>
                      {v.name} ({v.lang})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          )}

          <label className="block space-y-1 text-sm">
            <span className="text-muted-foreground">
              Rate / speed ({settings.speechRate.toFixed(2)})
            </span>
            <input
              type="range"
              min={0.7}
              max={1.5}
              step={0.05}
              value={settings.speechRate}
              className="w-full"
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  speechRate: Number(e.target.value),
                }))
              }
            />
          </label>
        </section>

        <Separator />

        <section className="space-y-3">
          <h3 className="text-sm font-medium">Video</h3>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.autoStartVideo}
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  autoStartVideo: e.target.checked,
                }))
              }
            />
            Auto-start camera when mic starts
          </label>
        </section>

        <Separator />

        <section className="space-y-2">
          <h3 className="text-sm font-medium">Server (read-only)</h3>
          {serverInfo ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">ASR</dt>
              <dd>
                <code>{serverInfo.asrMode}</code>
              </dd>
              <dt className="text-muted-foreground">TTS</dt>
              <dd>
                <code>{serverInfo.ttsMode}</code>
              </dd>
              <dt className="text-muted-foreground">VAD</dt>
              <dd>
                <code>{serverInfo.vadMode}</code>
              </dd>
              <dt className="text-muted-foreground">Half-duplex</dt>
              <dd>{serverInfo.halfDuplex ? "on" : "off"}</dd>
              <dt className="text-muted-foreground">Barge-in</dt>
              <dd>{serverInfo.bargeInEnabled ? "on" : "off"}</dd>
              <dt className="text-muted-foreground">Sustain / arm</dt>
              <dd>
                {serverInfo.sustainMs} ms / {serverInfo.listenArmMs} ms
              </dd>
              <dt className="text-muted-foreground">Vision</dt>
              <dd>{serverInfo.visionEnabled ? "enabled" : "disabled"}</dd>
            </dl>
          ) : (
            <p className="text-xs text-muted-foreground">
              Start mic to load server config from the perception WebSocket.
            </p>
          )}
        </section>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save}>Save</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
