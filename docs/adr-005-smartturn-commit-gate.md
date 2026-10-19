# ADR-005: Smart Turn Gate for Turn Commit

**Status:** Accepted
**Date:** 2026-10-19
**Related:** `mastra2/src/mastra/perception/turn.ts`, `smart-turn.ts`, `whisper-mel.ts`, `session.ts`, `scripts/fetch-smart-turn.sh`

## Context

Turn detection was heuristic only: `AdaptiveSilenceTurnDetector` commits on
adaptive silence thresholds, and the `TURN_MODE=semantic` name overclaimed what
it did - the code itself said the alias was "adaptive" with an honest
`SemanticTurnDetector = AdaptiveSilenceTurnDetector` deprecation. An ML
end-of-turn classifier is the industry-convergent answer: Pipecat ships
`LocalSmartTurnAnalyzerV3` as its default turn-stop strategy, and LiveKit ships
a comparable turn detector.

The 2026-10 industry survey could not verify Home Assistant's "semantic turn
detection model", *pipa*, or *Project GCI* against primary sources; designs
descending from those claims are folklore and this one does not follow them.
Sources followed: pipecat-ai/smart-turn (v3.2 CPU ONNX, HF weights), the HF
`WhisperFeatureExtractor` reference, and pipecat's documented
threshold-plus-fallback shape.

## Decision

1. **Gate, not replacement.** `GatedTurnDetector` wraps the unchanged
   `AdaptiveSilenceTurnDetector`. When the base would commit, the classifier is
   consulted on the last 8 s of utterance PCM: agree commits, disagree extends
   by `TURN_GATE_GRACE_MS` (default 600) and commits anyway after that (bounded,
   never a deadlock). Resumed speech cancels the pending verdict.
   `TURN_GATE=off` (default) is bit-identical to prior behaviour; the
   `semantic` alias is deleted.

2. **Feature extraction ported to TypeScript.** The ONNX export consumes
   `input_features` - Whisper log-mel, `[80, N]` float32 - not raw waveform, so
   `whisper-mel.ts` reimplements `WhisperFeatureExtractor`: centered STFT
   (hann 400, n_fft 400, hop 160; the non-power-of-two DFT via Bluestein),
   80-bin Slaney filterbank, `log10(max(1e-10, x))` then `(x + 4) / 4`. It is
   golden-exact against reference fixtures (max abs diff ~1e-7) and model
   probabilities land within 0.01 of the Python reference. No Python in the
   voice path.

3. **Model acquisition is explicit.** `yarn models` (a script, no postinstall
   hook) fetches `smart-turn-v3.2-cpu.onnx` (8.7 MB) to `~/.cache/hearsay/`.
   `SMART_TURN_MODEL_PATH` overrides. If the gate is requested but the model is
   missing or fails to load, the server logs one warning pointing at
   `yarn models`, emits a `turn_gate=fallback` metric, and behaves exactly like
   `TURN_GATE=off`. No exit, no prompt, no per-frame spam.

4. **Utterance window in session.** While an utterance is open, incoming PCM
   frames feed a bounded last-8 s int16 ring buffer, reset at every close
   point, exposed to the gate through `setWindowProvider`.

## Explicitly out of scope

- **Browser-side execution of the classifier.** Hearsay's invariant is that the
  browser is I/O and Node owns the loop; a commit verdict is loop state. The PCM
  is already in Node for VAD, so there is no locality win, only a protocol hop
  and per-device model downloads. `ASR_MODE=browser` keeps browser STT finals as
  the sole commit - the gate governs the `http|mock` path where PCM EOU commits.
- **Renting** LiveKit's hosted turn detector instead of running weights
  locally.
- LM/prosody scoring on partial transcripts (Phase B idea, unbuilt).

## Consequences

- Mid-sentence pauses should stop committing (the classifier says "continue"),
  and trailing silence on a completed thought can commit slightly earlier or
  later than pure thresholds.
- One new runtime dependency surface: onnxruntime-node sessions (already in the
  stack for Silero), serialized the same way because they are not reentrant.
- First utterance after boot pays model load if `SMART_TURN_MODEL_PATH` is
  configured; inference itself is well under the silence window it gates.
- Tests stay hermetic: golden fixtures for the mel port, stub classifiers for
  the gate, model-dependent tests skip when weights are absent.
