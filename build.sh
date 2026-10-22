#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
clang --target=wasm32 -O2 -nostdlib \
  -Wl,--no-entry -Wl,--export-memory \
  -Wl,--initial-memory=524288 -Wl,--max-memory=524288 \
  -Wl,--strip-all \
  core/scene.c -o core/scene.wasm
base64 < core/scene.wasm | tr -d '\n' > core/scene.wasm.b64
printf 'Built core/scene.wasm (%s bytes)\n' "$(wc -c < core/scene.wasm | tr -d ' ')"
