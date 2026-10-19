/**
 * Whisper log-mel feature extractor — TypeScript port of the HuggingFace
 * transformers WhisperFeatureExtractor (the exact tensor smart-turn-v3
 * consumes), for 16 kHz mono float32 audio, 8 s window.
 *
 * Validated against golden fixtures generated from HF transformers
 * (see tests + docs/adr-005). The implementation mirrors HF's numpy path:
 *
 * 1. Truncate/zero-pad input to 128000 samples (8 s). Normalization runs
 *    over the valid (pre-pad) length only: x = (x - mean) / sqrt(var + 1e-7).
 * 2. Center padding of 200 samples at each end uses Slaney REFLECT (mirror
 *    excluding the edge sample), not zero padding — confirmed by fixtures.
 * 3. STFT: 400-sample frames, periodic Hann window, hop 160, FFT size 400
 *    (not a power of two — computed exactly via Bluestein), one-sided
 *    power spectrum over 201 bins.
 * 4. 80-channel mel filterbank, Slaney piecewise-linear mel scale
 *    (linear <= 1 kHz, log above), area normalization (2 / (f[k+1] - f[k-1])).
 * 5. log10(max(1e-10, mel)), then an 8-decade dynamic-range floor relative
 *    to the window maximum, then (x + 4) / 4, cast to float32.
 */
export const N_FFT = 400;
export const HOP = 160;
export const N_MELS = 80;
export const FFT_BINS = N_FFT / 2 + 1; // 201
export const WINDOW_SECONDS = 8;
export const N_SAMPLES = 16_000 * WINDOW_SECONDS; // 128000
export const FRAME_PAD = N_FFT / 2; // 200
export const N_FRAMES = 800; // after dropping HF's final partial frame

// ---------------------------------------------------------------------------
// Bluestein DFT: exact length-400 DFT of a real sequence.
// X[k] = chirp[k] * sum_n ( x[n]*conj(chirp[n]) * conj(chirp[k-n]) )
// computed as a length-M (M = 1024 >= 2*400-1) circular convolution.
// ---------------------------------------------------------------------------
const BL_M = 1024;

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const ar = re[i + k];
        const ai = im[i + k];
        const br = re[i + k + half] * cr - im[i + k + half] * ci;
        const bi = re[i + k + half] * ci + im[i + k + half] * cr;
        re[i + k] = ar + br;
        im[i + k] = ai + bi;
        re[i + k + half] = ar - br;
        im[i + k + half] = ai - bi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

function chirp(k: number, n: number): [number, number] {
  const angle = (-Math.PI * (k * k)) / n; // exp(-i*pi*k^2/N)
  return [Math.cos(angle), Math.sin(angle)];
}

const B_RE = new Float64Array(BL_M);
const B_IM = new Float64Array(BL_M);
(function buildBluesteinKernel(): void {
  // b[m] = h[m] with h[m] = exp(+i*pi*m^2/N), wrapped circularly (h[-m]=h[m]),
  // zero outside |m| < N.
  for (let m = 0; m < BL_M; m++) {
    const idx = m < BL_M / 2 ? m : BL_M - m;
    if (idx >= N_FFT) continue;
    const [cr, ci] = chirp(idx, N_FFT); // exp(-i*pi*idx^2/N)
    B_RE[m] = cr; // h[idx] = conj(chirp) = (cr, -ci)
    B_IM[m] = -ci;
  }
  fft(B_RE, B_IM); // FFT of the kernel, reused every frame
})();

const CHIRP_RE = new Float64Array(N_FFT);
const CHIRP_IM = new Float64Array(N_FFT);
for (let k = 0; k < N_FFT; k++) {
  const [cr, ci] = chirp(k, N_FFT);
  CHIRP_RE[k] = cr;
  CHIRP_IM[k] = ci;
}

const yRe = new Float64Array(BL_M);
const yIm = new Float64Array(BL_M);
const Xre = new Float64Array(FFT_BINS);
const Xim = new Float64Array(FFT_BINS);

/** DFT bins 0..200 of the length-400 real sequence `x`, in place buffers. */
function bluestein(x: Float64Array): void {
  yRe.fill(0);
  yIm.fill(0);
  for (let n = 0; n < N_FFT; n++) {
    // a[n] = x[n] * chirp[n]
    yRe[n] = x[n]! * CHIRP_RE[n]!;
    yIm[n] = x[n]! * CHIRP_IM[n]!;
  }
  fft(yRe, yIm);
  for (let m = 0; m < BL_M; m++) {
    const ar = yRe[m]!;
    const ai = yIm[m]!;
    yRe[m] = ar * B_RE[m]! - ai * B_IM[m]!;
    yIm[m] = ar * B_IM[m]! + ai * B_RE[m]!;
  }
  // ifft(Z)[k] = conj(fft(conj(Z)))[k] / M
  for (let m = 0; m < BL_M; m++) yIm[m] = -yIm[m]!;
  fft(yRe, yIm);
  const inv = 1 / BL_M;
  for (let k = 0; k < FFT_BINS; k++) {
    // X[k] = chirp[k] * ifft(conv)[k]
    const zr = (yRe[k]! * CHIRP_RE[k]! + yIm[k]! * CHIRP_IM[k]!) * inv;
    const zi = (yRe[k]! * CHIRP_IM[k]! - yIm[k]! * CHIRP_RE[k]!) * inv;
    Xre[k] = zr;
    Xim[k] = zi;
  }
}

// ---------------------------------------------------------------------------
// Slaney piecewise-linear mel filterbank: (80 x 201) float64, row-major.
// ---------------------------------------------------------------------------
function buildMelBank(): Float64Array {
  const sr = 16_000;
  const fMax = sr / 2;
  const h2m = (f: number): number =>
    f < 1000 ? 1.5 * (f / 100) : 15 + (Math.log(Math.max(f, 1e-12) / 1000) * 27) / Math.log(6.4);
  const m2h = (m: number): number =>
    m < 15 ? (200 * m) / 3 : 1000 * Math.exp((m - 15) * Math.log(6.4) / 27);
  const edges: number[] = [];
  const mMax = h2m(fMax);
  for (let i = 0; i <= N_MELS + 1; i++) {
    edges.push(m2h(mMax * (i / (N_MELS + 1))));
  }
  const bank = new Float64Array(N_MELS * FFT_BINS);
  for (let k = 0; k < N_MELS; k++) {
    const lo = edges[k]!;
    const mid = edges[k + 1]!;
    const hi = edges[k + 2]!;
    const enorm = 2 / (hi - lo);
    for (let b = 0; b < FFT_BINS; b++) {
      const f = (b * fMax) / (FFT_BINS - 1);
      let w = 0;
      if (f >= lo && f <= mid) w = mid > lo ? (f - lo) / (mid - lo) : 0;
      else if (f > mid && f <= hi) w = hi > mid ? (hi - f) / (hi - mid) : 0;
      bank[k * FFT_BINS + b] = w * enorm;
    }
  }
  return bank;
}

const MEL_BANK = buildMelBank();

// Periodic Hann: w[k] = 0.5 - 0.5*cos(2*pi*k/N), k in [0, N)
const HANN = new Float64Array(N_FFT);
for (let k = 0; k < N_FFT; k++) {
  HANN[k] = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / N_FFT);
}

/**
 * Compute HF-style log-mel features for 16 kHz mono float32 audio.
 * Input shorter than 8 s is zero-padded on the tail (HF right pad); longer
 * input is truncated to 8 s. Returns a Float32Array of shape [80, 800]
 * (row-major), exactly the tensor shape the smart-turn ONNX export expects.
 */
export function computeWhisperMel(input: Float32Array): Float32Array {
  if (input.length === 0) return new Float32Array(N_MELS * N_FRAMES).fill(-1.5);

  // 1. pad/truncate to N_SAMPLES and z-normalize over the valid length.
  const valid = Math.min(input.length, N_SAMPLES);
  const padded = new Float64Array(N_SAMPLES);
  let mean = 0;
  for (let i = 0; i < valid; i++) mean += input[i]!;
  mean /= valid;
  let variance = 0;
  for (let i = 0; i < valid; i++) {
    const d = input[i]! - mean;
    variance += d * d;
  }
  variance /= valid;
  const invStd = 1 / Math.sqrt(variance + 1e-7);
  for (let i = 0; i < valid; i++) padded[i] = (input[i]! - mean) * invStd;
  // tail [valid, N_SAMPLES) stays zero

  // 2. center pad, Slaney reflect (mirror excluding edge sample).
  const paddedLen = N_SAMPLES + 2 * FRAME_PAD;
  const buf = new Float64Array(paddedLen);
  buf.set(padded.subarray(0, N_SAMPLES), FRAME_PAD);
  for (let i = 0; i < FRAME_PAD; i++) {
    buf[i] = padded[FRAME_PAD - i]; // left: x[200..1]
    buf[N_SAMPLES + FRAME_PAD + i] = padded[N_SAMPLES - 1 - (i + 1)]; // right: x[127998..127800]
  }

  // 3+4. STFT then mel, frame by frame; keep the log spectrum as float32.
  const logSpec = new Float32Array(N_MELS * (N_FRAMES + 1));
  const frame = new Float64Array(N_FFT);
  const power = new Float64Array(FFT_BINS);
  for (let f = 0; f <= N_FRAMES; f++) {
    const start = f * HOP;
    for (let k = 0; k < N_FFT; k++) frame[k] = buf[start + k]! * HANN[k]!;
    bluestein(frame);
    for (let b = 0; b < FFT_BINS; b++) {
      const re = Xre[b]!;
      const im = Xim[b]!;
      power[b] = re * re + im * im;
    }
    for (let m = 0; m < N_MELS; m++) {
      let acc = 0;
      const row = m * FFT_BINS;
      for (let b = 0; b < FFT_BINS; b++) acc += MEL_BANK[row + b]! * power[b]!;
      logSpec[m * (N_FRAMES + 1) + f] = Math.log10(Math.max(1e-10, acc));
    }
  }

  // 5. drop the final partial frame, apply the 8-decade floor, normalize.
  const frames = N_FRAMES + 1;
  let maxLog = -Infinity;
  for (const v of logSpec) if (v > maxLog) maxLog = v;
  const floor = maxLog - 8.0;
  const out = new Float32Array(N_MELS * N_FRAMES);
  for (let m = 0; m < N_MELS; m++) {
    for (let f = 0; f < N_FRAMES; f++) {
      let v = logSpec[m * frames + f]!;
      if (v < floor) v = floor;
      out[m * N_FRAMES + f] = (v + 4) / 4;
    }
  }
  return out;
}
