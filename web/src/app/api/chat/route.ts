import type { MessageListInput } from "@mastra/core/agent/message-list";
import { NextRequest } from "next/server";
import { createMastraClient } from "@/lib/mastra";
import { getServiceUrl, SERVICES, type ServiceId } from "@/lib/services";

type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

type ChatBody = {
  service?: ServiceId;
  agentId?: string;
  messages: ChatMessage[];
};

function encodeSse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as ChatBody;
  const serviceId = (body.service || "mastra2") as ServiceId;
  const messages = body.messages ?? [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");

  if (!(serviceId in SERVICES)) {
    return new Response(JSON.stringify({ error: "Unknown service" }), {
      status: 400,
    });
  }

  if (!lastUser?.content?.trim()) {
    return new Response(JSON.stringify({ error: "Message required" }), {
      status: 400,
    });
  }

  const service = SERVICES[serviceId];
  const encoder = new TextEncoder();

  if (service.kind === "mastra-server") {
    const agentId = body.agentId || "hearsay-agent";
    const client = createMastraClient(serviceId);
    const agent = client.getAgent(agentId);

    const stream = new ReadableStream({
      async start(controller) {
        try {
          const messageList = messages.map((m) => ({
            role: m.role,
            content: m.content,
          })) as MessageListInput;

          const response = await agent.stream(messageList);

          await response.processDataStream({
            onChunk: async (chunk) => {
              controller.enqueue(
                encoder.encode(encodeSse("chunk", chunk)),
              );
            },
          });

          controller.enqueue(encoder.encode(encodeSse("done", { type: "done" })));
        } catch (error) {
          controller.enqueue(
            encoder.encode(
              encodeSse("error", {
                type: "error",
                error: error instanceof Error ? error.message : String(error),
              }),
            ),
          );
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  // Legacy OpenAI-compatible Hearsay Mastra server
  const baseUrl = getServiceUrl(serviceId);
  const upstream = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "hearsay",
      stream: true,
      messages,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return new Response(
      JSON.stringify({
        error: text || `Upstream error ${upstream.status}`,
      }),
      { status: 502 },
    );
  }

  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === "[DONE]") {
              controller.enqueue(
                encoder.encode(encodeSse("done", { type: "done" })),
              );
              continue;
            }
            try {
              const json = JSON.parse(payload);
              const delta =
                json?.choices?.[0]?.delta?.content ??
                json?.delta?.content ??
                "";
              if (delta) {
                controller.enqueue(
                  encoder.encode(
                    encodeSse("chunk", {
                      type: "text-delta",
                      payload: { text: delta },
                    }),
                  ),
                );
              }
            } catch {
              // ignore malformed SSE lines
            }
          }
        }
        controller.enqueue(encoder.encode(encodeSse("done", { type: "done" })));
      } catch (error) {
        controller.enqueue(
          encoder.encode(
            encodeSse("error", {
              type: "error",
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
