import { emptyScene, type SceneMemory } from "./types.ts";

export interface VisionAdapter {
  /** Accept a JPEG/data URL frame; may ignore (Step A). */
  onFrame(input: {
    t_ms: number;
    dataUrl: string;
    width?: number;
    height?: number;
  }): Promise<SceneMemory | null>;
  getScene(): SceneMemory;
  reset(): void;
}

/**
 * Step A stub: accepts frames and drops them.
 * Step B: pHash → gate → VLM describe → overwrite SceneMemory.
 */
export class StubVisionAdapter implements VisionAdapter {
  private scene: SceneMemory = emptyScene();

  async onFrame(): Promise<SceneMemory | null> {
    return null;
  }

  getScene(): SceneMemory {
    return this.scene;
  }

  reset(): void {
    this.scene = emptyScene();
  }
}
