# VAD models

Silero ONNX weights are loaded from the `avr-vad` package (`silero_vad_v5.onnx`).

Optional: copy into this folder for offline inspection:

```bash
cp node_modules/avr-vad/silero_vad_v5.onnx ./models/
```

`VAD_MODE=silero` (default) uses avr-vad + onnxruntime-node. Set `VAD_MODE=energy` to fall back to RMS gating (`VAD_ENERGY_THRESHOLD`).
