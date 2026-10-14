"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  CopilotKit,
  useFrontendTool,
  useHumanInTheLoop,
} from "@copilotkit/react-core";
import { CopilotChat } from "@copilotkit/react-ui";
import "@copilotkit/react-ui/styles.css";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const RUNTIME_URL =
  process.env.NEXT_PUBLIC_COPILOTKIT_URL ||
  "http://localhost:4111/copilotkit";

const AGENT_KEY = "hearsayAgent";

function AskUserCard({
  question,
  respond,
}: {
  question: string;
  respond?: (value: unknown) => void;
}) {
  const [answer, setAnswer] = useState("");
  return (
    <Card className="my-2 border-sky-500/40">
      <CardHeader className="py-3">
        <CardTitle className="text-sm">Hearsay is asking</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 pb-3">
        <p className="text-sm">{question}</p>
        <div className="flex gap-2">
          <Input
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Your answer"
            onKeyDown={(e) => {
              if (e.key === "Enter" && respond) {
                respond({ answer });
              }
            }}
          />
          <Button
            size="sm"
            onClick={() => respond?.({ answer })}
            disabled={!respond}
          >
            Reply
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function OfferChoicesCard({
  prompt,
  choices,
  respond,
}: {
  prompt: string;
  choices: string[];
  respond?: (value: unknown) => void;
}) {
  return (
    <Card className="my-2 border-amber-500/40">
      <CardHeader className="py-3">
        <CardTitle className="text-sm">Pick one</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 pb-3">
        <p className="text-sm">{prompt}</p>
        <p className="text-xs text-muted-foreground">
          Click an option, or say the number / label in Presence.
        </p>
        <div className="flex flex-col gap-2">
          {choices.map((choice, i) => (
            <Button
              key={`${i}-${choice}`}
              variant="outline"
              size="sm"
              className="h-auto justify-start whitespace-normal px-3 py-2 text-left"
              disabled={!respond}
              onClick={() =>
                respond?.({
                  choice,
                  index: i,
                  answer: choice,
                })
              }
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
  );
}

function HearsayFrontendTools() {
  useHumanInTheLoop({
    name: "ask_user",
    description:
      "Ask the user a clarifying question and wait for their answer.",
    parameters: [
      {
        name: "question",
        type: "string",
        description: "Short plain question for the user",
        required: true,
      },
    ],
    render: ({ args, respond, status }) => {
      if (status === "complete") {
        return <span className="sr-only">answered</span>;
      }
      return (
        <AskUserCard
          question={String(args?.question ?? "")}
          respond={respond}
        />
      );
    },
  });

  useHumanInTheLoop({
    name: "offer_choices",
    description:
      "Present 2–6 short options the user can pick by clicking or by saying the number/label.",
    parameters: [
      {
        name: "prompt",
        type: "string",
        description: "Short question shown above the choices",
        required: true,
      },
      {
        name: "choices",
        type: "string[]",
        description: "Short option labels",
        required: true,
      },
    ],
    render: ({ args, respond, status }) => {
      if (status === "complete") {
        return <span className="sr-only">chose</span>;
      }
      const choices = Array.isArray(args?.choices)
        ? args.choices.map((c: unknown) => String(c))
        : [];
      return (
        <OfferChoicesCard
          prompt={String(args?.prompt ?? "Pick one")}
          choices={choices}
          respond={respond}
        />
      );
    },
  });

  useFrontendTool({
    name: "request_camera_frame",
    description:
      "Capture a fresh webcam frame from the laptop for scene updates.",
    parameters: [
      {
        name: "reason",
        type: "string",
        description: "Why a new look is needed",
        required: false,
      },
    ],
    handler: async ({ reason }) => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480 },
          audio: false,
        });
        const video = document.createElement("video");
        video.srcObject = stream;
        video.muted = true;
        await video.play();
        await new Promise((r) => setTimeout(r, 400));
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 352;
        canvas.getContext("2d")?.drawImage(video, 0, 0, 640, 352);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
        stream.getTracks().forEach((t) => t.stop());
        return {
          ok: true,
          description: reason
            ? `Captured frame (${reason})`
            : "Captured frame",
          dataUrl,
          width: 640,
          height: 352,
        };
      } catch (err) {
        return {
          ok: false,
          description:
            err instanceof Error ? err.message : "Camera capture failed",
        };
      }
    },
  });

  useFrontendTool({
    name: "capture_screenshot",
    description:
      "Capture the laptop screen, a window, or a browser tab to help with on-computer tasks.",
    parameters: [
      {
        name: "reason",
        type: "string",
        description: "What to look for on screen",
        required: false,
      },
    ],
    handler: async ({ reason }) => {
      const { captureScreenshotFrame } = await import(
        "@/lib/perception/capture-screenshot"
      );
      return captureScreenshotFrame(
        typeof reason === "string" ? reason : undefined,
      );
    },
  });

  return null;
}

function CopilotKitMount() {
  return (
    <CopilotKit runtimeUrl={RUNTIME_URL} agent={AGENT_KEY}>
      <HearsayFrontendTools />
      <CopilotChat
        className="flex-1"
        labels={{
          title: "Hearsay",
          initial:
            "Hi — ask me anything. I can offer choices, look at the webcam, or capture your screen to help with desktop tasks.",
        }}
      />
    </CopilotKit>
  );
}

export function CopilotChatApp() {
  // CopilotKit calls crypto.randomUUID during render — defer until client mount
  // to avoid Next.js blocking prerender errors.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(true);
  }, []);

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Hearsay · CopilotKit
          </p>
          <h1 className="text-lg font-semibold">Chat</h1>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link href="/presence">Eyes & ears</Link>
        </Button>
      </header>
      <div className="flex flex-1 flex-col">
        {ready ? (
          <CopilotKitMount />
        ) : (
          <p className="p-4 text-sm text-muted-foreground">Loading chat…</p>
        )}
      </div>
    </div>
  );
}
