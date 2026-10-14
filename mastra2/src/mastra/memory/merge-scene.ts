import type { Memory } from "@mastra/memory";
import {
  emptySceneWorkingMemory,
  type SceneWorkingMemory,
} from "./scene-schema.ts";
import { hearsayResourceId } from "./hearsay-memory.ts";

/**
 * Merge a partial scene update into resource-scoped working memory.
 * Vision / request_camera_frame paths own this — not the LLM inventing objects.
 */
export async function mergeSceneWorkingMemory(
  memory: Memory,
  partial: Partial<SceneWorkingMemory>,
  opts?: { threadId?: string; resourceId?: string },
): Promise<SceneWorkingMemory> {
  const threadId = opts?.threadId || "scene-writer";
  const resourceId = opts?.resourceId || hearsayResourceId;

  const existingRaw = await memory.getWorkingMemory({
    threadId,
    resourceId,
  });

  let existing: SceneWorkingMemory = emptySceneWorkingMemory();
  if (existingRaw) {
    try {
      existing = {
        ...emptySceneWorkingMemory(),
        ...(JSON.parse(existingRaw) as SceneWorkingMemory),
      };
    } catch {
      // fall through with empty
    }
  }

  const merged: SceneWorkingMemory = {
    ...existing,
    ...partial,
    updatedAt: partial.updatedAt ?? Date.now(),
    // Arrays replace when provided (schema merge semantics)
    people: partial.people ?? existing.people,
    objects: partial.objects ?? existing.objects,
    notes: partial.notes ?? existing.notes,
  };

  if (await memory.supportsAtomicWorkingMemoryMerge()) {
    await memory.mergeWorkingMemory({
      threadId,
      resourceId,
      workingMemory: merged,
    });
  } else {
    await memory.updateWorkingMemory({
      threadId,
      resourceId,
      workingMemory: JSON.stringify(merged),
    });
  }

  return merged;
}

/**
 * Apply a client camera frame result into working memory.
 * Clear stale people/objects so prior invented scene notes cannot stick.
 * Grounded text comes from request_camera_frame (vision describe); WS frames
 * often only carry capture metadata until that tool runs.
 */
export async function mergeFrameIntoWorkingMemory(
  memory: Memory,
  frame: {
    description?: string;
    dataUrl?: string;
    width?: number;
    height?: number;
  },
  opts?: { threadId?: string; resourceId?: string },
): Promise<SceneWorkingMemory> {
  const hasImage = Boolean(frame.dataUrl?.startsWith("data:image/"));
  const size =
    frame.width && frame.height ? `${frame.width}x${frame.height}` : null;
  const noteParts = [
    frame.description?.trim(),
    size ? `frame ${size}` : null,
    hasImage ? "jpeg on wire" : null,
  ].filter(Boolean) as string[];

  return mergeSceneWorkingMemory(
    memory,
    {
      notes: noteParts.length
        ? [`camera: ${noteParts.join(" — ")}`]
        : ["camera: frame received"],
      // Fresh capture invalidates prior world-model guesses
      people: [],
      objects: [],
      updatedAt: Date.now(),
    },
    opts,
  );
}
