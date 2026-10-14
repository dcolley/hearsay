"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Radio, SendHorizontal, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { SERVICES, type ServiceId } from "@/lib/services";
import { cn } from "@/lib/utils";

type ChatRole = "user" | "assistant" | "system";

type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
};

type AgentInfo = {
  id: string;
  name: string;
  description?: string;
};

function extractTextDelta(chunk: unknown): string {
  if (!chunk || typeof chunk !== "object") return "";
  const c = chunk as Record<string, unknown>;

  if (c.type === "text-delta") {
    const payload = c.payload as Record<string, unknown> | undefined;
    if (typeof payload?.text === "string") return payload.text;
    if (typeof c.textDelta === "string") return c.textDelta;
    if (typeof c.text === "string") return c.text;
  }

  if (typeof c.textDelta === "string") return c.textDelta;
  if (typeof c.delta === "string") return c.delta;

  return "";
}

export function ChatApp() {
  const [serviceId, setServiceId] = useState<ServiceId>("mastra2");
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentId, setAgentId] = useState<string>("");
  const [healthOk, setHealthOk] = useState<boolean | null>(null);
  const [healthDetail, setHealthDetail] = useState("Checking…");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const service = SERVICES[serviceId];

  const refreshMeta = useCallback(async (nextService: ServiceId) => {
    setHealthOk(null);
    setHealthDetail("Checking…");
    setError(null);

    const [healthRes, agentsRes] = await Promise.all([
      fetch(`/api/health?service=${nextService}`),
      fetch(`/api/agents?service=${nextService}`),
    ]);

    const health = await healthRes.json();
    const agentsPayload = await agentsRes.json();

    setHealthOk(Boolean(health.ok));
    setHealthDetail(
      health.ok
        ? `Connected · ${health.baseUrl}`
        : health.error || "Unavailable",
    );

    const nextAgents: AgentInfo[] = agentsPayload.agents ?? [];
    setAgents(nextAgents);
    setAgentId((current) => {
      if (current && nextAgents.some((a) => a.id === current)) return current;
      return nextAgents[0]?.id ?? "";
    });
  }, []);

  useEffect(() => {
    void refreshMeta(serviceId);
  }, [serviceId, refreshMeta]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  const canSend = useMemo(
    () => Boolean(input.trim()) && !sending && Boolean(agentId),
    [input, sending, agentId],
  );

  async function onSend() {
    if (!canSend) return;
    const content = input.trim();
    setInput("");
    setError(null);

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content,
    };
    const assistantId = crypto.randomUUID();
    const history = [...messages, userMessage];

    setMessages([
      ...history,
      { id: assistantId, role: "assistant", content: "" },
    ]);
    setSending(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service: serviceId,
          agentId,
          messages: history.map(({ role, content: text }) => ({
            role,
            content: text,
          })),
        }),
      });

      if (!res.ok || !res.body) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `Request failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          const lines = part.split("\n");
          let event = "message";
          let data = "";
          for (const line of lines) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (!data) continue;

          const parsed = JSON.parse(data);
          if (event === "error") {
            throw new Error(parsed.error || "Stream error");
          }
          if (event === "chunk") {
            const delta = extractTextDelta(parsed);
            if (!delta) continue;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, content: m.content + delta }
                  : m,
              ),
            );
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId && !m.content
            ? { ...m, content: `Error: ${message}` }
            : m,
        ),
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <p className="text-sm font-medium tracking-[0.18em] text-muted-foreground uppercase">
            Hearsay
          </p>
          <h1 className="font-heading text-3xl font-semibold tracking-tight">
            Mastra Console
          </h1>
          <p className="max-w-xl text-sm text-muted-foreground">
            Frontend for the local Mastra services — chat with agents from
            Studio or the legacy Hearsay brain.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href="/presence">Eyes & ears</Link>
          </Button>
          <Badge
            variant={healthOk ? "secondary" : "destructive"}
            className="w-fit gap-1.5"
          >
            <Radio className="size-3.5" />
            {healthOk === null ? "Checking" : healthOk ? "Online" : "Offline"}
          </Badge>
        </div>
      </header>

      <div className="grid flex-1 gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
        <Card className="h-fit">
          <CardHeader className="gap-1">
            <CardTitle className="text-base">Service</CardTitle>
            <CardDescription className="text-xs leading-relaxed">
              {service.description}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Select
              value={serviceId}
              onValueChange={(value) => {
                setServiceId(value as ServiceId);
                setMessages([]);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.values(SERVICES).map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Agent</p>
              <Select
                value={agentId}
                onValueChange={setAgentId}
                disabled={!agents.length}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="No agents" />
                </SelectTrigger>
                <SelectContent>
                  {agents.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Separator />

            <p className="text-xs leading-relaxed text-muted-foreground">
              {healthDetail}
            </p>

            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => void refreshMeta(serviceId)}
            >
              Refresh status
            </Button>
          </CardContent>
        </Card>

        <Card className="flex min-h-[32rem] flex-col overflow-hidden">
          <CardHeader className="border-b">
            <div className="flex items-center gap-2">
              <Sparkles className="size-4 text-muted-foreground" />
              <CardTitle className="text-base">
                {agents.find((a) => a.id === agentId)?.name || "Chat"}
              </CardTitle>
            </div>
            <CardDescription className="text-xs">
              Messages stream through Next.js API routes into the selected
              Mastra backend.
            </CardDescription>
          </CardHeader>

          <CardContent className="flex flex-1 flex-col gap-4 p-0">
            <ScrollArea className="flex-1 px-4 py-4">
              <div className="space-y-4">
                {messages.length === 0 && (
                  <div className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
                    Ask the weather agent for a city, or switch to Hearsay Mastra
                    when that server is running.
                  </div>
                )}

                {messages.map((message) => (
                  <div
                    key={message.id}
                    className={cn(
                      "flex",
                      message.role === "user" ? "justify-end" : "justify-start",
                    )}
                  >
                    <div
                      className={cn(
                        "max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap",
                        message.role === "user"
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-foreground",
                      )}
                    >
                      {message.content || (sending ? "…" : "")}
                    </div>
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>
            </ScrollArea>

            <div className="border-t p-4">
              {error && (
                <p className="mb-3 text-sm text-destructive">{error}</p>
              )}
              <div className="flex items-end gap-2">
                <Textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Message the agent…"
                  className="min-h-12 max-h-40 resize-none"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void onSend();
                    }
                  }}
                />
                <Button
                  size="icon"
                  disabled={!canSend}
                  onClick={() => void onSend()}
                  aria-label="Send message"
                >
                  {sending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <SendHorizontal className="size-4" />
                  )}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
