/**
 * WebrtcAecPlayback timer-safety (review F2). The module is browser-bound,
 * so this drives it through a minimal fake window (controllable timer queue)
 * plus a tiny AudioContext-like stub — no real audio graph, no peer handshake.
 * The fakes are deliberately dumb: they record calls and let the test advance
 * a virtual clock.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { WebrtcAecPlayback } from "./webrtc-aec-playback";

type TimerTask = { id: number; fn: () => void; due: number; every?: number };

let clock = 0;
let tasks = new Map<number, TimerTask>();
let nextId = 1;

function installFakeWindow(): void {
  clock = 0;
  tasks = new Map();
  nextId = 1;
  (globalThis as Record<string, unknown>).window = {
    setTimeout: (fn: () => void, ms?: number) => {
      const id = nextId++;
      tasks.set(id, { id, fn, due: clock + (ms ?? 0) });
      return id;
    },
    setInterval: (fn: () => void, ms?: number) => {
      const id = nextId++;
      tasks.set(id, { id, fn, due: clock + (ms ?? 0), every: ms ?? 0 });
      return id;
    },
    clearTimeout: (id: number) => {
      tasks.delete(id);
    },
    clearInterval: (id: number) => {
      tasks.delete(id);
    },
  };
}

/** Run all fake timers due within ms, flushing microtasks between each. */
async function advance(ms: number): Promise<void> {
  const target = clock + ms;
  for (let guard = 0; guard < 1000; guard++) {
    let next: TimerTask | undefined;
    for (const t of tasks.values()) {
      if (t.due <= target && (!next || t.due < next.due)) next = t;
    }
    if (!next) break;
    clock = next.due;
    if (next.every && next.every > 0) {
      tasks.set(next.id, { ...next, due: clock + next.every });
    } else {
      tasks.delete(next.id);
    }
    next.fn();
    for (let i = 0; i < 12; i++) await Promise.resolve();
  }
  clock = target;
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

const flush = () => advance(0);

type Param = {
  value: number;
  calls: string[];
  cancelScheduledValues(t: number): void;
  setValueAtTime(v: number, t: number): void;
  linearRampToValueAtTime(v: number, t: number): void;
};

function makeParam(): Param {
  return {
    value: 1,
    calls: [],
    cancelScheduledValues() {
      this.calls.push("cancel");
    },
    setValueAtTime() {
      this.calls.push("setValueAtTime");
    },
    linearRampToValueAtTime() {
      this.calls.push("ramp");
    },
  };
}

function makeSource() {
  return {
    buffer: null as unknown,
    connect: () => {},
    disconnect: () => {},
    stop: () => {},
    start: () => {},
    onended: null as null | (() => void),
  };
}

type Harness = {
  playback: WebrtcAecPlayback;
  param: Param;
  source: ReturnType<typeof makeSource> | null;
  el: { volume: number; muted: boolean; play(): Promise<void>; pause(): void; remove(): void };
  gen: () => number;
  fadeStopTimer: () => number | null;
  fadeStepTimer: () => number | null;
  buffersStarted: () => number;
};

/**
 * Pre-wire the sink so playAudioBuffer skips bootstrap (peers/ctx/dest are
 * non-null → ensureReady early-returns). No RTCPeerConnection, no fetch.
 */
function makeHarness(): Harness {
  const playback = new WebrtcAecPlayback();
  const param = makeParam();
  const gain = { gain: param, connect: () => {}, disconnect: () => {} };
  let sources = 0;
  let currentSource: ReturnType<typeof makeSource> | null = null;
  const ctx = {
    currentTime: 0,
    state: "running",
    createBufferSource: () => {
      sources++;
      currentSource = makeSource();
      return currentSource;
    },
    resume: async () => {},
    close: async () => {},
  };
  const dest = { disconnect: () => {}, stream: { getAudioTracks: () => [] } };
  const el = {
    volume: 1,
    muted: false,
    play: async () => {},
    pause: () => {},
    remove: () => {},
  };
  const peers = {
    local: { close: () => {} },
    remote: { close: () => {} },
  };
  Object.assign(playback as unknown as Record<string, unknown>, {
    ctx,
    dest,
    gain,
    peers,
    remoteAudio: el,
  });
  return {
    playback,
    param,
    source: currentSource,
    el,
    gen: () => (playback as unknown as { generation: number }).generation,
    fadeStopTimer: () =>
      (playback as unknown as { fadeStopTimer: number | null }).fadeStopTimer,
    fadeStepTimer: () =>
      (playback as unknown as { fadeStepTimer: number | null }).fadeStepTimer,
    buffersStarted: () => sources,
  };
}

/** A buffer long enough that playAudioBuffer parks on its poll interval. */
const buffer = { duration: 10 } as unknown as AudioBuffer;

describe("WebrtcAecPlayback fade timers (F2)", () => {
  beforeEach(() => installFakeWindow());

  it("starting a new clip during a fade is not killed by the stale stop timer", async () => {
    const h = makeHarness();
    void h.playback.playAudioBuffer(buffer);
    await flush();
    assert.equal(h.playback.isPlaying(), true);

    h.playback.stopWithFade(100);
    assert.ok(h.fadeStopTimer() != null, "fade stop timer must be tracked");

    // New playback starts 30 ms into the fade — the pending stop must not fire.
    void h.playback.playAudioBuffer(buffer);
    await flush();
    await advance(150);

    assert.equal(h.gen(), 0, "stale fade stop must not bump generation");
    assert.equal(h.buffersStarted(), 2);
    // unduckOutput must cancel a leftover ramp before revoicing (F2 second half).
    assert.ok(h.param.calls.includes("cancel"));
    assert.equal(h.param.value, 1);
  });

  it("stop() before the fade lands kills both deferred timers", async () => {
    const h = makeHarness();
    void h.playback.playAudioBuffer(buffer);
    await flush();
    h.playback.stopWithFade(100);
    h.playback.stop();
    assert.equal(h.fadeStopTimer(), null);
    assert.equal(h.fadeStepTimer(), null);

    const genAfterStop = h.gen();
    await advance(150);
    assert.equal(h.gen(), genAfterStop, "fade stop timer must not fire after stop()");
    assert.equal(h.el.volume, 0, "volume step-ramp must not re-voice a stopped element");
  });

  it("close() clears a fade in flight", async () => {
    const h = makeHarness();
    void h.playback.playAudioBuffer(buffer);
    await flush();
    h.playback.stopWithFade(100);
    h.playback.close();
    assert.equal(h.fadeStopTimer(), null);
    assert.equal(h.fadeStepTimer(), null);
    const gen = h.gen();
    await advance(150);
    assert.equal(h.gen(), gen, "nothing may fire after close()");
  });

  it("stopWithFade with no live source or context hard-stops without stale timers", () => {
    const h = makeHarness();
    h.playback.stopWithFade(100); // no source yet → immediate hard stop
    assert.equal(h.fadeStopTimer(), null);
    assert.equal(h.gen(), 1);
    // Double stop is safe.
    h.playback.stop();
    assert.equal(h.gen(), 2);
  });
});
