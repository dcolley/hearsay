import { z } from "zod";

export const scenePersonSchema = z.object({
  id: z.string(),
  description: z.string(),
  characteristics: z.array(z.string()).optional(),
});

export const sceneObjectSchema = z.object({
  id: z.string(),
  label: z.string(),
  location: z.string().optional(),
  characteristics: z.array(z.string()).optional(),
  lastSeenAt: z.number().optional(),
});

/** Resource-scoped working memory for camera world model. */
export const sceneWorkingMemorySchema = z.object({
  updatedAt: z.number().optional(),
  location: z.string().optional(),
  people: z.array(scenePersonSchema).optional(),
  objects: z.array(sceneObjectSchema).optional(),
  notes: z.array(z.string()).optional(),
});

export type SceneWorkingMemory = z.infer<typeof sceneWorkingMemorySchema>;

export function emptySceneWorkingMemory(): SceneWorkingMemory {
  return {
    updatedAt: 0,
    location: "",
    people: [],
    objects: [],
    notes: [],
  };
}
