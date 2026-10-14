import { MastraClient } from "@mastra/client-js";
import { getServiceUrl, type ServiceId } from "./services";

export function createMastraClient(serviceId: ServiceId = "mastra2") {
  return new MastraClient({
    baseUrl: getServiceUrl(serviceId),
  });
}
