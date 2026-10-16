import { Memory } from "@mastra/memory";
import { LibSQLStore } from "@mastra/libsql";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { sceneWorkingMemorySchema } from "./scene-schema.ts";
import { stripNarrationFromMessage } from "../perception/narration-guard.ts";

const defaultDbPath = resolve(process.cwd(), "data/hearsay-memory.db");
const defaultDbUrl = `file:${defaultDbPath}`;

let storageSingleton: LibSQLStore | null = null;
let memorySingleton: HearsayMemory | null = null;

/**
 * Memory with a narration guard: before assistant messages persist, any
 * sentence that is exactly a progress-narration line ("Let me check.",
 * "Still working on it.", tool lines) is stripped. Narration is spoken
 * out-of-band (ADR-003) and must not teach the model to answer fillers;
 * this covers the leak routes (model echo, future in-stream narration).
 *
 * The stream path persists via `memory.saveMessages`, so this subclass is
 * the single choke point (ADR-003 memory hygiene).
 */
export class HearsayMemory extends Memory {
  saveMessages(
    ...args: Parameters<Memory["saveMessages"]>
  ): ReturnType<Memory["saveMessages"]> {
    const [input] = args;
    if (input?.messages?.length) {
      return super.saveMessages({
        ...input,
        messages: input.messages.map(stripNarrationFromMessage),
      });
    }
    return super.saveMessages(...args);
  }
}

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
  memorySingleton = new HearsayMemory({
    storage,
    options: {
      lastMessages: 24,
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
