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
  getPocketStatus,
  listPocketBuiltinVoices,
  onPocketStatus,
  preloadPocket,
  type PocketLoadStatus,
} from "@/lib/perception/pocket-tts";
import { listPocketClones } from "@/lib/perception/pocket-voice-store";
import {
  listSpeechVoices,
  loadPresenceSettings,
  pickDefaultVoice,
  savePresenceSettings,
  type BrowserTtsEngine,
  type PresenceSettings,
} from "@/lib/perception/presence-settings";
import { CloneVoiceDialog } from "./clone-voice-dialog";

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

function formatPocketStatus(s: PocketLoadStatus): string {
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

function parseEngine(v: string): BrowserTtsEngine {
  if (v === "kokoro" || v === "pocket" || v === "speechSynthesis") return v;
  return "speechSynthesis";
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
  const [pocketStatus, setPocketStatus] = useState<PocketLoadStatus>(() =>
    getPocketStatus(),
  );
  const [loadingKokoro, setLoadingKokoro] = useState(false);
  const [loadingPocket, setLoadingPocket] = useState(false);
  const [pocketVoices, setPocketVoices] = useState(() =>
    listPocketBuiltinVoices(),
  );
  const [clones, setClones] = useState<{ id: string; name: string }[]>([]);
  const [cloneOpen, setCloneOpen] = useState(false);

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
    const unsubK = onKokoroStatus(setKokoroStatus);
    const unsubP = onPocketStatus((s) => {
      setPocketStatus(s);
      if (s.state === "ready") setPocketVoices(listPocketBuiltinVoices());
    });
    void listPocketClones()
      .then((list) => setClones(list.map((c) => ({ id: c.id, name: c.name }))))
      .catch(() => setClones([]));
    return () => {
      window.speechSynthesis?.removeEventListener("voiceschanged", refresh);
      unsubK();
      unsubP();
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

  async function loadPocketModel() {
    setLoadingPocket(true);
    try {
      await preloadPocket({ voiceCloning: false });
      setPocketVoices(listPocketBuiltinVoices());
    } catch {
      // status listener
    } finally {
      setLoadingPocket(false);
    }
  }

  const httpMode = serverInfo?.ttsMode?.toLowerCase() === "http";

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
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
            {httpMode ? (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                Server TTS mode is <code>http</code> — browser engine / Pocket
                clone prefs are ignored until you set{" "}
                <code>TTS_MODE=browser</code> and restart perception.
              </p>
            ) : null}
            <label className="block space-y-1 text-sm">
              <span className="text-muted-foreground">Browser TTS engine</span>
              <Select
                value={settings.browserTtsEngine}
                onValueChange={(v) =>
                  setSettings((s) => ({
                    ...s,
                    browserTtsEngine: parseEngine(v),
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
                  <SelectItem value="pocket">
                    Pocket TTS (built-ins + optional clone)
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
            ) : null}

            {settings.browserTtsEngine === "pocket" ? (
              <>
                <label className="block space-y-1 text-sm">
                  <span className="text-muted-foreground">Output voice</span>
                  <Select
                    value={settings.pocketOutputSource}
                    onValueChange={(v) =>
                      setSettings((s) => ({
                        ...s,
                        pocketOutputSource:
                          v === "cloned" ? "cloned" : "builtin",
                      }))
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="builtin">Built-in Pocket voice</SelectItem>
                      <SelectItem
                        value="cloned"
                        disabled={clones.length === 0}
                      >
                        Cloned voice
                        {clones.length === 0 ? " (none saved)" : ""}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </label>

                {settings.pocketOutputSource === "builtin" ? (
                  <label className="block space-y-1 text-sm">
                    <span className="text-muted-foreground">
                      Built-in voice
                    </span>
                    <Select
                      value={settings.pocketBuiltinVoice}
                      onValueChange={(pocketBuiltinVoice) =>
                        setSettings((s) => ({ ...s, pocketBuiltinVoice }))
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {pocketVoices.map((v) => (
                          <SelectItem key={v.id} value={v.id}>
                            {v.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                ) : (
                  <label className="block space-y-1 text-sm">
                    <span className="text-muted-foreground">Cloned voice</span>
                    <Select
                      value={settings.pocketClonedVoiceId || undefined}
                      onValueChange={(pocketClonedVoiceId) =>
                        setSettings((s) => ({ ...s, pocketClonedVoiceId }))
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select a clone" />
                      </SelectTrigger>
                      <SelectContent>
                        {clones.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                )}

                <p className="text-xs text-muted-foreground">
                  Status: {formatPocketStatus(pocketStatus)}. Built-ins do not
                  need the clone encoder. Model weights stay in Cache Storage;
                  clones in IndexedDB. Kyutai Pocket TTS · CC-BY-4.0.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={loadingPocket || pocketStatus.state === "ready"}
                    onClick={() => void loadPocketModel()}
                  >
                    {pocketStatus.state === "ready"
                      ? "Pocket ready"
                      : loadingPocket
                        ? "Loading…"
                        : "Load Pocket model"}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setCloneOpen(true)}
                  >
                    Clone a voice…
                  </Button>
                </div>
              </>
            ) : null}

            {settings.browserTtsEngine === "speechSynthesis" ? (
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
            ) : null}

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

      <CloneVoiceDialog
        open={cloneOpen}
        onOpenChange={(next) => {
          setCloneOpen(next);
          if (!next) {
            void listPocketClones()
              .then((list) => {
                setClones(list.map((c) => ({ id: c.id, name: c.name })));
                setSettings((s) => {
                  if (
                    s.pocketOutputSource === "cloned" &&
                    s.pocketClonedVoiceId &&
                    !list.some((c) => c.id === s.pocketClonedVoiceId)
                  ) {
                    return {
                      ...s,
                      pocketOutputSource: "builtin",
                      pocketClonedVoiceId: "",
                    };
                  }
                  return s;
                });
              })
              .catch(() => undefined);
          }
        }}
        onUseForOutput={(cloneId) => {
          setSettings((s) => ({
            ...s,
            browserTtsEngine: "pocket",
            pocketOutputSource: "cloned",
            pocketClonedVoiceId: cloneId,
          }));
          void listPocketClones()
            .then((list) =>
              setClones(list.map((c) => ({ id: c.id, name: c.name }))),
            )
            .catch(() => undefined);
        }}
      />
    </>
  );
}
