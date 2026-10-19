/**
 * TTS-agnostic WebRTC loopback sink.
 *
 * Browser AEC only cancels audio treated as a WebRTC far-end. Local
 * HTMLAudioElement / Web Audio → speakers is invisible to AEC. This module
 * routes any blob URL / AudioBuffer through a local RTCPeerConnection pair so
 * getUserMedia(echoCancellation) can cancel playback from the mic.
 *
 * What the user hears is the *remote* HTMLAudioElement. Stopping the local
 * AudioBufferSourceNode does not flush WebRTC jitter — barge/soft-pause must
 * mute/pause that element (and zero the send gain) or audio keeps playing.
 */

type PeerPair = {
  local: RTCPeerConnection;
  remote: RTCPeerConnection;
};

/** Extra ms after local source end for remote peer playout. */
const LOOPBACK_TAIL_MS = 400;
/** Soft-pause duck level (not full mute — leaves a cue that TTS is paused). */
const DUCK_GAIN = 0.12;

export class WebrtcAecPlayback {
  private ctx: AudioContext | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private peers: PeerPair | null = null;
  private remoteAudio: HTMLAudioElement | null = null;
  private currentSource: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private ready: Promise<void> | null = null;
  private generation = 0;
  private playing = false;

  async ensureReady(): Promise<void> {
    if (this.peers && this.ctx && this.dest) return;
    if (this.ready) return this.ready;

    this.ready = this.bootstrap().catch((err) => {
      this.ready = null;
      throw err;
    });
    return this.ready;
  }

  /** True while a clip is scheduled through the loopback (including tail). */
  isPlaying(): boolean {
    return this.playing;
  }

  /** Decode and play a blob/object URL through the AEC loopback. */
  async playUrl(url: string): Promise<void> {
    await this.ensureReady();
    const ctx = this.ctx!;
    const res = await fetch(url);
    const raw = await res.arrayBuffer();
    const buffer = await ctx.decodeAudioData(raw.slice(0));
    await this.playAudioBuffer(buffer);
  }

  async playAudioBuffer(buffer: AudioBuffer): Promise<void> {
    await this.ensureReady();
    const ctx = this.ctx!;
    const dest = this.dest!;
    const gain = this.gain!;
    const gen = this.generation;

    this.stopCurrentSource();
    this.unduckOutput();

    if (ctx.state === "suspended") {
      await ctx.resume().catch(() => undefined);
    }

    this.playing = true;
    try {
      await new Promise<void>((resolve) => {
        if (gen !== this.generation) {
          resolve();
          return;
        }

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(gain);
        gain.connect(dest);
        this.currentSource = source;

        const startAt = ctx.currentTime;
        const doneAtMs =
          performance.now() + buffer.duration * 1000 + LOOPBACK_TAIL_MS;

        let settled = false;
        let poll: number | undefined;

        const finish = () => {
          if (settled) return;
          settled = true;
          if (poll != null) window.clearInterval(poll);
          if (this.currentSource === source) this.currentSource = null;
          try {
            source.disconnect();
          } catch {
            // already disconnected
          }
          resolve();
        };

        source.onended = () => {
          const wait = Math.max(0, doneAtMs - performance.now());
          window.setTimeout(() => finish(), wait);
        };

        try {
          source.start(0);
        } catch {
          finish();
          return;
        }

        poll = window.setInterval(() => {
          if (gen !== this.generation) {
            finish();
            return;
          }
          if (
            ctx.currentTime >=
            startAt + buffer.duration + LOOPBACK_TAIL_MS / 1000
          ) {
            finish();
          }
        }, 50);
      });
    } finally {
      this.playing = false;
    }
  }

  /** Soft barge: duck volume immediately (remote element + send gain). */
  pause(): void {
    if (this.gain) this.gain.gain.value = DUCK_GAIN;
    if (this.remoteAudio) {
      this.remoteAudio.volume = DUCK_GAIN;
    }
    void this.ctx?.suspend().catch(() => undefined);
  }

  resume(): void {
    this.unduckOutput();
    void this.ctx?.resume().catch(() => undefined);
    void this.remoteAudio?.play().catch(() => undefined);
  }

  /**
   * Silence over fadeMs, then hard stop (ADR-006). The send gain AudioParam
   * ramps linearly, the remote element volume step-ramps (HTMLAudioElement
   * volume is not schedulable), and the full cut lands after fadeMs.
   */
  stopWithFade(fadeMs: number): void {
    if (fadeMs <= 0 || !this.ctx || !this.gain || !this.currentSource) {
      this.stop();
      return;
    }
    const ctx = this.ctx;
    const param = this.gain.gain;
    try {
      const now = ctx.currentTime;
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
      param.linearRampToValueAtTime(0, now + fadeMs / 1000);
    } catch {
      this.stop();
      return;
    }
    if (this.remoteAudio) {
      const el = this.remoteAudio;
      const start = el.muted ? 0 : el.volume;
      const steps = Math.max(1, Math.round(fadeMs / 25));
      let i = 0;
      const step = window.setInterval(() => {
        i++;
        if (i >= steps) {
          window.clearInterval(step);
          el.volume = 0;
          return;
        }
        el.volume = Math.max(0, start * (1 - i / steps));
      }, 25);
    }
    window.setTimeout(() => this.stop(), fadeMs);
  }

  /**
   * Hard barge — silence speakers now. Must mute remote HTMLAudioElement;
   * stopping the local source alone leaves WebRTC-buffered audio audible.
   */
  stop(): void {
    this.generation += 1;
    this.playing = false;
    this.stopCurrentSource();
    if (this.gain) this.gain.gain.value = 0;
    if (this.remoteAudio) {
      this.remoteAudio.volume = 0;
      this.remoteAudio.muted = true;
      this.remoteAudio.pause();
    }
    // Keep context running so the next clip can start without a resume race
    void this.ctx?.resume().catch(() => undefined);
  }

  close(): void {
    this.stop();
    if (this.remoteAudio) {
      this.remoteAudio.srcObject = null;
      this.remoteAudio.remove();
      this.remoteAudio = null;
    }
    if (this.peers) {
      this.peers.local.close();
      this.peers.remote.close();
      this.peers = null;
    }
    this.dest?.disconnect();
    this.gain?.disconnect();
    this.dest = null;
    this.gain = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.ready = null;
  }

  private unduckOutput(): void {
    if (this.gain) this.gain.gain.value = 1;
    if (this.remoteAudio) {
      this.remoteAudio.muted = false;
      this.remoteAudio.volume = 1;
    }
  }

  private stopCurrentSource(): void {
    if (!this.currentSource) return;
    try {
      this.currentSource.onended = null;
      this.currentSource.stop();
      this.currentSource.disconnect();
    } catch {
      // already stopped
    }
    this.currentSource = null;
  }

  private async bootstrap(): Promise<void> {
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    const gain = ctx.createGain();
    gain.gain.value = 1;

    const local = new RTCPeerConnection();
    const remote = new RTCPeerConnection();

    local.onicecandidate = (ev) => {
      if (ev.candidate) void remote.addIceCandidate(ev.candidate);
    };
    remote.onicecandidate = (ev) => {
      if (ev.candidate) void local.addIceCandidate(ev.candidate);
    };

    const remoteAudio = document.createElement("audio");
    remoteAudio.autoplay = true;
    remoteAudio.setAttribute("playsinline", "true");
    remoteAudio.style.display = "none";
    document.body.appendChild(remoteAudio);

    remote.ontrack = (ev) => {
      const [stream] = ev.streams;
      if (stream) {
        remoteAudio.srcObject = stream;
        void remoteAudio.play().catch(() => undefined);
      }
    };

    for (const track of dest.stream.getAudioTracks()) {
      local.addTrack(track, dest.stream);
    }

    const offer = await local.createOffer();
    await local.setLocalDescription(offer);
    await remote.setRemoteDescription(offer);
    const answer = await remote.createAnswer();
    await remote.setLocalDescription(answer);
    await local.setRemoteDescription(answer);

    this.ctx = ctx;
    this.dest = dest;
    this.gain = gain;
    this.peers = { local, remote };
    this.remoteAudio = remoteAudio;
  }
}
