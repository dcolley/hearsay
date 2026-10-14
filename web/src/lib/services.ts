export type ServiceId = "mastra2" | "mastra";

export type ServiceConfig = {
  id: ServiceId;
  name: string;
  description: string;
  defaultUrl: string;
  envKey: "MASTRA2_URL" | "MASTRA_URL";
  kind: "mastra-server" | "openai-compatible";
};

export const SERVICES: Record<ServiceId, ServiceConfig> = {
  mastra2: {
    id: "mastra2",
    name: "Mastra 2",
    description: "Mastra Studio server with agents & tools",
    defaultUrl: "http://localhost:4111",
    envKey: "MASTRA2_URL",
    kind: "mastra-server",
  },
  mastra: {
    id: "mastra",
    name: "Hearsay Mastra",
    description: "Legacy Express brain for the voice dock",
    defaultUrl: "http://localhost:3000",
    envKey: "MASTRA_URL",
    kind: "openai-compatible",
  },
};

export function getServiceUrl(serviceId: ServiceId): string {
  const service = SERVICES[serviceId];
  return process.env[service.envKey] || service.defaultUrl;
}
