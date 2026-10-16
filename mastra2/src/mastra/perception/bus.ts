type Handler<T> = (payload: T) => void;

/**
 * Tiny typed pub/sub between perception adapters and the session.
 * Perception writes events; the session (and WS) subscribe — never the reverse.
 */
export class EventBus<Events extends Record<string, unknown>> {
  private handlers = new Map<keyof Events, Set<Handler<unknown>>>();

  on<K extends keyof Events>(event: K, handler: Handler<Events[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<unknown>);
    return () => set!.delete(handler as Handler<unknown>);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[bus] handler error for ${String(event)}:`, err);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}

export type PerceptionEvents = {
  speech_start: { t_ms: number };
  speech_end: { t_ms: number };
  partial: { text: string };
  end_of_turn: { text: string; t_ms: number };
  scene_update: import("./types.ts").SceneMemory;
  state: { state: import("./types.ts").AgentState };
  tts_chunk: { audio?: Buffer; text?: string; mime?: string };
  tts_end: { t_ms: number };
  /** End of assistant speak — client drains then replies playback_done. */
  tts_flush: { t_ms: number };
  /** Post-TTS arm delay (US30): armed=false while deaf to new turns. */
  listen_arm: { t_ms: number; armed: boolean; until_ms: number };
  error: { error: string };
  /** Hard interrupt — client must stop TTS immediately. */
  barge_in: { t_ms: number };
  /** Soft candidate (US20) — pause TTS while sustain is evaluated. */
  barge_soft_pause: { t_ms: number };
  /** Soft candidate cleared — resume TTS if still speaking. */
  barge_resume: { t_ms: number };
  /** Latency / yield telemetry (server logs + optional client). */
  metric: {
    name: string;
    t_ms: number;
    detail?: Record<string, number | string | boolean>;
  };
  /** Hydrated Mastra thread turns for the Presence conversation UI. */
  conversation_history: {
    messages: import("./types.ts").ConversationTurn[];
  };
  /** Thread wiped + new threadId minted. */
  session_cleared: { threadId: string; resourceId: string };
};
