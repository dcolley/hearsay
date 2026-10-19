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
 * Write-gate surface used by the speculation machinery (ADR-007): while
 * blocked, message persistence is buffered and never reaches storage.
 */
export interface MemoryWriteGate {
  blockWrites(on: boolean): void;
  readonly writesBlocked: boolean;
  flushPending(): Promise<void>;
  clearPending(): void;
}

/**
 * Memory with two structural gates:
 *
 * 1. Narration guard (ADR-003): before assistant messages persist, any
 *    sentence that is exactly a progress-narration line ("Let me check.",
 *    "Still working on it.", tool lines) is stripped.
 *
 * 2. Write gate (ADR-007): `blockWrites(true)` buffers every message write
 *    and persists nothing. Speculative generation runs with writes blocked
 *    so a discarded speculation leaves zero memory rows; a confirmed turn
 *    flushes the buffer exactly once.
 *
 * Both gates cover BOTH entry points, because `saveMessages` alone is NOT
 * the whole stream path: a console-trace spike on @mastra/memory 1.37
 * showed `agent.stream()` persisting via `MessageHistory.persistMessages`
 * straight into the storage memory domain, bypassing `Memory.saveMessages`
 * (the mastra-ai/mastra#22873 bug shape). So the gate also wraps the
 * storage domain's `saveMessages`/`persistMessages` in `ensureWriteGate`.
 */
export class HearsayMemory extends Memory implements MemoryWriteGate {
  private writeBlockedFlag = false;
  private flushing = false;
  private pendingWrites: Array<{ messages: Parameters<Memory["saveMessages"]>[0]["messages"] }> = [];
  private readonly storageRef: unknown;
  private gateInstall: Promise<void> | null = null;

  constructor(config: ConstructorParameters<typeof Memory>[0]) {
    super(config);
    this.storageRef = (config as { storage?: unknown })?.storage;
  }

  get writesBlocked(): boolean {
    return this.writeBlockedFlag;
  }

  /**
   * Turn the write gate on/off. While on, every message write (this class
   * OR the storage-domain shortcut the loop uses) is buffered, not stored.
   */
  blockWrites(on: boolean): void {
    this.writeBlockedFlag = on;
    if (on) void this.ensureWriteGate();
  }

  /** Buffer is dropped, nothing reaches storage. */
  clearPending(): void {
    this.pendingWrites = [];
  }

  /** Persist every buffered write in arrival order, bypassing the gate. */
  async flushPending(): Promise<void> {
    await this.ensureWriteGate();
    const items = this.pendingWrites;
    this.pendingWrites = [];
    this.flushing = true;
    try {
      for (const item of items) {
        await super.saveMessages({ messages: item.messages.map(stripNarrationFromMessage) });
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Install the storage-domain wrapper. Safe to call repeatedly. */
  async ensureWriteGate(): Promise<void> {
    this.gateInstall ??= this.installStorageGate();
    await this.gateInstall;
  }

  private async installStorageGate(): Promise<void> {
    const storage = this.storageRef as
      | { getStore?: (domain: string) => Promise<Record<string, unknown> | null> }
      | undefined;
    if (!storage || typeof storage.getStore !== "function") return;
    const domain = await storage.getStore("memory");
    if (!domain || (domain as { __hearsayWriteGate?: boolean }).__hearsayWriteGate) return;
    (domain as { __hearsayWriteGate?: boolean }).__hearsayWriteGate = true;
    const mem = this;
    const buffer = (messages: unknown): boolean => {
      if (!mem.writeBlockedFlag || mem.flushing) return false;
      if (Array.isArray(messages) && messages.length > 0) {
        mem.pendingWrites.push({ messages: messages as never });
      }
      return true;
    };
    const origSave = domain.saveMessages as
      | ((args: { messages: unknown }) => Promise<unknown>)
      | undefined;
    if (origSave) {
      const save = origSave.bind(domain);
      domain.saveMessages = async (args: { messages: unknown }) => {
        if (buffer(args?.messages)) return { messages: args.messages };
        return save(args);
      };
    }
    const origPersist = domain.persistMessages as
      | ((messages: unknown, threadId: string, resourceId?: string) => Promise<unknown>)
      | undefined;
    if (origPersist) {
      const persist = origPersist.bind(domain);
      domain.persistMessages = async (messages: unknown, threadId: string, resourceId?: string) => {
        if (buffer(messages)) return undefined;
        return persist(messages, threadId, resourceId);
      };
    }
  }

  saveMessages(
    ...args: Parameters<Memory["saveMessages"]>
  ): ReturnType<Memory["saveMessages"]> {
    const [input] = args;
    if (this.writeBlockedFlag && !this.flushing) {
      if (input?.messages?.length) {
        this.pendingWrites.push({ messages: input.messages });
      }
      // no-op-shaped result: callers may read .messages, nothing persisted.
      return Promise.resolve({ messages: input?.messages ?? [] });
    }
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
