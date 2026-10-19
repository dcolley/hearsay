#!/usr/bin/env bash
# Fetch smart-turn-v3.2-cpu.onnx for the semantic turn gate (explicit task only:
# `yarn models`; never wired into postinstall or any automatic hook).
# Idempotent: downloads only when the file is missing. Echoes the resolved path.
set -euo pipefail

URL="https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-cpu.onnx"
DEST="${SMART_TURN_MODEL_PATH:-$HOME/.cache/hearsay/smart-turn-v3.2-cpu.onnx}"

if [ -f "$DEST" ]; then
  echo "$DEST"
  exit 0
fi

mkdir -p "$(dirname "$DEST")"
echo "fetching smart-turn-v3.2-cpu.onnx -> $DEST" >&2
if ! curl -L --fail --retry 3 --output "$DEST.part" "$URL"; then
  rm -f "$DEST.part"
  echo "smart-turn model fetch failed" >&2
  exit 1
fi
mv "$DEST.part" "$DEST"
echo "$DEST"
