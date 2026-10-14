import { NextRequest, NextResponse } from "next/server";
import { getServiceUrl, SERVICES, type ServiceId } from "@/lib/services";
import { createMastraClient } from "@/lib/mastra";

export async function GET(request: NextRequest) {
  const serviceId = (request.nextUrl.searchParams.get("service") ||
    "mastra2") as ServiceId;

  if (!(serviceId in SERVICES)) {
    return NextResponse.json({ error: "Unknown service" }, { status: 400 });
  }

  const baseUrl = getServiceUrl(serviceId);
  const service = SERVICES[serviceId];

  try {
    if (service.kind === "mastra-server") {
      const client = createMastraClient(serviceId);
      const agents = await client.listAgents();
      return NextResponse.json({
        ok: true,
        service: serviceId,
        baseUrl,
        agents: Object.keys(agents),
      });
    }

    const res = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(4000),
    });
    const body = await res.json().catch(() => ({}));
    return NextResponse.json({
      ok: res.ok,
      service: serviceId,
      baseUrl,
      status: res.status,
      body,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        service: serviceId,
        baseUrl,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
}
