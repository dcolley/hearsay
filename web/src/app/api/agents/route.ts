import { NextRequest, NextResponse } from "next/server";
import { createMastraClient } from "@/lib/mastra";
import { SERVICES, type ServiceId } from "@/lib/services";

export async function GET(request: NextRequest) {
  const serviceId = (request.nextUrl.searchParams.get("service") ||
    "mastra2") as ServiceId;

  if (!(serviceId in SERVICES)) {
    return NextResponse.json({ error: "Unknown service" }, { status: 400 });
  }

  const service = SERVICES[serviceId];

  if (service.kind === "openai-compatible") {
    return NextResponse.json({
      service: serviceId,
      agents: [
        {
          id: "hearsay",
          name: "Hearsay",
          description: "Voice-dock agent via OpenAI-compatible chat API",
        },
      ],
    });
  }

  try {
    const client = createMastraClient(serviceId);
    const agents = await client.listAgents();
    const list = Object.entries(agents).map(([id, agent]) => ({
      id,
      name: (agent as { name?: string }).name ?? id,
      description:
        typeof (agent as { instructions?: unknown }).instructions === "string"
          ? ((agent as { instructions: string }).instructions.slice(0, 160) ||
            undefined)
          : undefined,
    }));

    return NextResponse.json({ service: serviceId, agents: list });
  } catch (error) {
    return NextResponse.json(
      {
        service: serviceId,
        agents: [],
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
}
