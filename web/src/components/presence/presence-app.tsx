"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Mic,
  MicOff,
  Radio,
  Settings,
  Video,
  VideoOff,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { PresenceSettingsDialog } from "@/components/presence/presence-settings-dialog";
import {
  MediaCapture,
  matchChoiceResult,
  type ClientAction,
} from "@/lib/perception/media-capture";
import type { AgentState, ServerHelloInfo } from "@/lib/perception/protocol";
import {
  DEFAULT_PRESENCE_SETTINGS,
  loadPresenceSettings,
  type PresenceSettings,
} from "@/lib/perception/presence-settings";
import { cn } from "@/lib/utils";

const STATE_LABEL: Record<AgentState, string> = {
  idle: "Idle — waiting for speech",
  listening: "Listening",
  thinking: "Thinking (calling model)",
  speaking: "Speaking",
  interrupted: "Interrupted",
  awaiting_user: "Waiting for your answer",
};

export function PresenceApp() {
  // Defaults on first paint so SSR HTML matches the client; hydrate from localStorage after mount.
  const [settings, setSettings] = useState<PresenceSettings>(() => ({
    ...DEFAULT_PRESENCE_SETTINGS,
  }));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [videoOn, setVideoOn] = useState(false);
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<AgentState>("idle");
  const [partial, setPartial] = useState("");
  const [transcript, setTranscript] = useState("");
  const [assistant, setAssistant] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [textInput, setTextInput] = useState("");
  const [threadId, setThreadId] = useState("");
  const [resourceId, setResourceId] = useState("");
  const [serverInfo, setServerInfo] = useState<ServerHelloInfo | null>(null);
  const [hitlPrompt, setHitlPrompt] = useState<{
    id: string;
    kind: "ask_user" | "offer_choices";
    prompt: string;
    choices?: string[];
  } | null>(null);
  const [askAnswer, setAskAnswer] = useState("");
  const [listenArmed, setListenArmed] = useState(true);
  const [toolLog, setToolLog] = useState<
    {
      id: string;
      tool: string;
      args: Record<string, unknown>;
      status: "pending" | "done" | "error";
      detail?: string;
      thumb?: string;
      t: number;
    }[]
  >([]);
  const captureRef = useRef<MediaCapture | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    setSettings(loadPresenceSettings());
  }, []);

  const pushToolLog = useCallback(
    (
      entry: {
        id: string;
        tool: string;
        args: Record<string, unknown>;
        status: "pending" | "done" | "error";
        detail?: string;
        thumb?: string;
      },
    ) => {
      setToolLog((prev) => {
        const i = prev.findIndex((e) => e.id === entry.id);
        const next = { ...entry, t: Date.now() };
        if (i === -1) return [...prev, next].slice(-12);
        const copy = [...prev];
        copy[i] = { ...copy[i]!, ...next };
        return copy;
      });
    },
    [],
  );

  const handleClientAction = useCallback(
    async (action: ClientAction) => {
      const capture = captureRef.current;
      if (!capture) return;

      // Tool calls are UI-only — never spoken via TTS
      pushToolLog({
        id: action.id,
        tool: action.tool,
        args: action.args,
        status: "pending",
      });

      if (action.tool === "ask_user") {
        setHitlPrompt({
          id: action.id,
          kind: "ask_user",
          prompt: String(action.args.question ?? ""),
        });
        setAskAnswer("");
        capture.setPendingAskUser(action.id);
        return;
      }

      if (action.tool === "offer_choices") {
        const choices = Array.isArray(action.args.choices)
          ? action.args.choices.map((c) => String(c))
          : [];
        setHitlPrompt({
          id: action.id,
          kind: "offer_choices",
          prompt: String(action.args.prompt ?? "Pick one"),
          choices,
        });
        setAskAnswer("");
        capture.setPendingAskUser(action.id, choices);
        return;
      }

      if (action.tool === "request_camera_frame") {
        const frame = await capture.captureCameraFrame(
          String(action.args.reason ?? ""),
        );
        // Include real dataUrl so server toModelOutput can pass JPEG image parts to Spark.
        capture.sendToolResult(action.id, {
          ok: frame.ok,
          result: {
            ok: frame.ok,
            description: frame.description,
            width: frame.width,
            height: frame.height,
            dataUrl: frame.dataUrl,
          },
          error: frame.ok ? undefined : frame.description,
        });
        if (frame.ok && frame.dataUrl) {
          capture.sendFrame({
            dataUrl: frame.dataUrl,
            width: frame.width,
            height: frame.height,
            description: frame.description,
          });
        }
        pushToolLog({
          id: action.id,
          tool: action.tool,
          args: action.args,
          status: frame.ok ? "done" : "error",
          detail: frame.description || (frame.ok ? "frame ok" : "failed"),
          thumb: frame.ok ? frame.dataUrl : undefined,
        });
        return;
      }

      if (action.tool === "capture_screenshot") {
        const shot = await capture.captureScreenshot(
          String(action.args.reason ?? ""),
        );
        capture.sendToolResult(action.id, {
          ok: shot.ok,
          result: {
            ok: shot.ok,
            description: shot.description,
            width: shot.width,
            height: shot.height,
            dataUrl: shot.dataUrl,
          },
          error: shot.ok ? undefined : shot.description,
        });
        pushToolLog({
          id: action.id,
          tool: action.tool,
          args: action.args,
          status: shot.ok ? "done" : "error",
          detail: shot.description || (shot.ok ? "screenshot ok" : "failed"),
          thumb: shot.ok ? shot.dataUrl : undefined,
        });
      }
    },
    [pushToolLog],
  );

  const stop = useCallback(async () => {
    captureRef.current?.setPendingAskUser(null);
    await captureRef.current?.stop();
    captureRef.current = null;
    setRunning(false);
    setVideoOn(false);
    setConnected(false);
    setState("idle");
    setHitlPrompt(null);
    setToolLog([]);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setPartial("");
    setTranscript("");
    setAssistant("");
    setHitlPrompt(null);
    setToolLog([]);

    const prefs = loadPresenceSettings();
    setSettings(prefs);

    const capture = new MediaCapture({
      wsUrl: prefs.wsUrl,
      videoEl: videoRef.current,
      handlers: {
        onConnection: setConnected,
        onState: setState,
        onPartial: setPartial,
        onTranscript: (t) => {
          setTranscript(t);
          setPartial("");
          setAssistant("");
        },
        onAssistantText: (t) => {
          setAssistant((prev) => (prev ? `${prev} ${t}` : t));
        },
        onError: (msg) => {
          // Non-fatal client noise — log only
          if (/kokoro/i.test(msg) && /fallback/i.test(msg)) {
            console.warn(msg);
            return;
          }
          if (/Int16Array/i.test(msg) && /multiple of 2/i.test(msg)) {
            console.warn(msg);
            return;
          }
          setError(msg);
        },
        onAskUserAnswered: (id, answer) => {
          pushToolLog({
            id,
            tool: "hitl",
            args: {},
            status: "done",
            detail: `answer: ${answer}`,
          });
          setHitlPrompt(null);
          setAskAnswer("");
          setTranscript(answer);
          setPartial("");
        },
        onHello: (info) => {
          setThreadId(info.threadId);
          setResourceId(info.resourceId);
          setServerInfo(info);
        },
        onListenArm: setListenArmed,
        onVideo: setVideoOn,
        onClientAction: (action) => {
          void handleClientAction(action);
        },
      },
    });

    captureRef.current = capture;
    try {
      await capture.start();
      setRunning(true);
      if (prefs.autoStartVideo) {
        await capture.startVideo();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await capture.stop();
      captureRef.current = null;
      setRunning(false);
      setVideoOn(false);
    }
  }, [handleClientAction]);

  useEffect(() => {
    return () => {
      void captureRef.current?.stop();
    };
  }, []);

  async function toggleVideo() {
    const capture = captureRef.current;
    if (!capture || !running) return;
    try {
      if (capture.isVideoActive()) {
        capture.stopVideo();
      } else {
        await capture.startVideo();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function fulfillHitl(spokenOrTyped: string) {
    if (!hitlPrompt || !captureRef.current) return;
    const text = spokenOrTyped.trim() || "(no answer)";
    captureRef.current.setPendingAskUser(null);
    const result =
      hitlPrompt.kind === "offer_choices" && hitlPrompt.choices?.length
        ? matchChoiceResult(text, hitlPrompt.choices)
        : { answer: text };
    captureRef.current.sendToolResult(hitlPrompt.id, {
      ok: true,
      result,
    });
    pushToolLog({
      id: hitlPrompt.id,
      tool: hitlPrompt.kind,
      args: {
        prompt: hitlPrompt.prompt,
        choices: hitlPrompt.choices,
      },
      status: "done",
      detail: `answer: ${"choice" in result ? result.choice : text}`,
    });
    setHitlPrompt(null);
    setAskAnswer("");
    setTranscript(text);
    setPartial("");
  }

  function sendText() {
    const text = textInput.trim();
    if (!text || !captureRef.current) return;
    setAssistant("");
    // Typed reply while HITL is open → fulfill the tool
    if (hitlPrompt) {
      fulfillHitl(text);
      setTextInput("");
      return;
    }
    captureRef.current.sendTextUtterance(text);
    setTextInput("");
  }

  function submitAsk() {
    if (!hitlPrompt) return;
    fulfillHitl(askAnswer.trim() || "(no answer)");
  }

  function pickChoice(choice: string) {
    fulfillHitl(choice);
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 p-4 md:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Hearsay · Laptop presence
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">Eyes & ears</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings className="size-4" />
            Settings
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <Link href="/">Chat</Link>
          </Button>
          <Badge variant={connected ? "default" : "secondary"}>
            <Radio className="size-3" />
            {connected ? "WS connected" : "WS offline"}
          </Badge>
        </div>
      </header>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">Session</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                className={cn(
                  state === "listening" && "bg-emerald-600",
                  state === "thinking" && "bg-amber-600",
                  state === "speaking" && "bg-sky-600",
                )}
              >
                {STATE_LABEL[state]}
              </Badge>
              {running && state === "listening" && !listenArmed ? (
                <Badge variant="secondary">Cooling down</Badge>
              ) : null}
              {running && state === "listening" && listenArmed ? (
                <Badge variant="outline">Armed</Badge>
              ) : null}
            </div>
          </div>
          <CardDescription className="space-y-1">
            <span className="block">
              Perception WS:{" "}
              <code className="text-xs">{settings.wsUrl}</code>
            </span>
            {threadId ? (
              <span className="block text-xs">
                thread {threadId.slice(0, 8)}… · resource {resourceId}
              </span>
            ) : null}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            {!running ? (
              <Button onClick={() => void start()}>
                <Mic className="size-4" />
                Start mic
              </Button>
            ) : (
              <Button variant="destructive" onClick={() => void stop()}>
                <MicOff className="size-4" />
                Stop mic
              </Button>
            )}
            <Button
              variant="outline"
              disabled={!running}
              onClick={() => void toggleVideo()}
            >
              {videoOn ? (
                <>
                  <VideoOff className="size-4" />
                  Stop video
                </>
              ) : (
                <>
                  <Video className="size-4" />
                  Start video
                </>
              )}
            </Button>
          </div>

          <video
            ref={videoRef}
            className={cn(
              "aspect-video w-full rounded-md bg-black/80 object-cover",
              !videoOn && "hidden",
            )}
            muted
            playsInline
          />

          <Separator />

          <div className="space-y-2 text-sm">
            <p className="text-muted-foreground">You said</p>
            <p className="min-h-6">
              {transcript || partial || (
                <span className="text-muted-foreground">—</span>
              )}
            </p>
            <p className="text-muted-foreground">Hearsay</p>
            <p className="min-h-6">
              {assistant || <span className="text-muted-foreground">—</span>}
            </p>
          </div>

          {toolLog.length > 0 ? (
            <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-xs">
              <p className="font-medium text-muted-foreground">
                Tool calls (UI only — not spoken)
              </p>
              <ul className="space-y-2">
                {toolLog.map((e) => (
                  <li key={e.id} className="flex gap-2">
                    {e.thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={e.thumb}
                        alt=""
                        className="size-12 shrink-0 rounded object-cover"
                      />
                    ) : null}
                    <div className="min-w-0 flex-1">
                      <p>
                        <code>{e.tool}</code>{" "}
                        <Badge
                          variant={
                            e.status === "error"
                              ? "destructive"
                              : e.status === "done"
                                ? "default"
                                : "secondary"
                          }
                          className="align-middle text-[10px]"
                        >
                          {e.status}
                        </Badge>
                      </p>
                      <p className="truncate text-muted-foreground">
                        {JSON.stringify(e.args)}
                      </p>
                      {e.detail ? (
                        <p className="text-muted-foreground">{e.detail}</p>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {hitlPrompt?.kind === "ask_user" ? (
            <Card className="border-sky-500/40">
              <CardHeader className="py-3">
                <CardTitle className="text-sm">Hearsay is asking</CardTitle>
                <CardDescription>{hitlPrompt.prompt}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 pb-3">
                <p className="text-xs text-muted-foreground">
                  Speak your answer, or type below.
                </p>
                <div className="flex gap-2">
                  <Input
                    value={askAnswer}
                    onChange={(e) => setAskAnswer(e.target.value)}
                    placeholder="Your answer"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitAsk();
                    }}
                  />
                  <Button onClick={submitAsk}>Reply</Button>
                </div>
              </CardContent>
            </Card>
          ) : null}

          {hitlPrompt?.kind === "offer_choices" ? (
            <Card className="border-amber-500/40">
              <CardHeader className="py-3">
                <CardTitle className="text-sm">Pick one</CardTitle>
                <CardDescription>{hitlPrompt.prompt}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 pb-3">
                <p className="text-xs text-muted-foreground">
                  Click an option, or say the number / label.
                </p>
                <div className="flex flex-col gap-2">
                  {(hitlPrompt.choices ?? []).map((choice, i) => (
                    <Button
                      key={`${i}-${choice}`}
                      variant="outline"
                      className="h-auto justify-start whitespace-normal px-3 py-2 text-left"
                      onClick={() => pickChoice(choice)}
                    >
                      <span className="mr-2 font-semibold text-muted-foreground">
                        {i + 1}.
                      </span>
                      {choice}
                    </Button>
                  ))}
                </div>
              </CardContent>
            </Card>
          ) : null}

          {error ? (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <Separator />

          <div className="flex gap-2">
            <Input
              placeholder="Type a turn (calls Spark without ASR)"
              value={textInput}
              disabled={!running}
              onChange={(e) => setTextInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") sendText();
              }}
            />
            <Button disabled={!running || !textInput.trim()} onClick={sendText}>
              Send
            </Button>
          </div>
        </CardContent>
      </Card>

      <PresenceSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        serverInfo={serverInfo}
        onSaved={(next) => {
          setSettings(next);
          captureRef.current?.reloadTtsSettings();
        }}
      />
    </div>
  );
}
