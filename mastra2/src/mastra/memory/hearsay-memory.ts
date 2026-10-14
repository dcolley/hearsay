import { Memory } from "@mastra/memory";
import { LibSQLStore } from "@mastra/libsql";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { sceneWorkingMemorySchema } from "./scene-schema.ts";

const defaultDbPath = resolve(process.cwd(), "data/hearsay-memory.db");
const defaultDbUrl = `file:${defaultDbPath}`;

let storageSingleton: LibSQLStore | null = null;
let memorySingleton: Memory | null = null;

export function createHearsayStorage() {
  if (storageSingleton) return storageSingleton;
  mkdirSync(resolve(process.cwd(), "data"), { recursive: true });
  const url = process.env.MEMORY_DB_URL?.trim() || defaultDbUrl;
  storageSingleton = new LibSQLStore({
    id: "hearsay-memory",
    url,
  });
  return storageSingleton;
}

export function createHearsayMemory(storage = createHearsayStorage()) {
  if (memorySingleton) return memorySingleton;
  memorySingleton = new Memory({
    storage,
    options: {
      lastMessages: 12,
      // Observational memory was inventing/persisting wrong scene facts (e.g. phones).
      // Camera grounding uses schema working memory + live describe instead.
      observationalMemory: false,
      workingMemory: {
        enabled: true,
        scope: "resource",
        schema: sceneWorkingMemorySchema,
      },
    },
  });
  return memorySingleton;
}

export const hearsayResourceId =
  process.env.HEARSAY_RESOURCE_ID?.trim() || "hearsay-laptop";
