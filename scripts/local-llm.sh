#!/usr/bin/env bash
# Runs an open-weight model (Qwen3 4B, Apache-2.0) locally with llama.cpp on 127.0.0.1.
# No API key, quota or data leaving the machine. Linux x86_64; first run downloads about 2.5 GB.
set -euo pipefail

DIR="${SOLGUARD_LLM_DIR:-$HOME/.local/share/solguard-llm}"
PORT="${PORT:-8089}"
BUILD=b12780
ARCHIVE_SHA=af1a4550f9cbccc9ca589b88b3758b472aaea9d100f7ee9a8664b50a6d35da26
MODEL=Qwen3-4B-Q4_K_M.gguf
MODEL_SHA=7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5

# Download to a temporary name and keep the file only if its checksum matches.
fetch() {
  local url=$1 sha=$2 out=$3
  [ -f "$out" ] && return
  curl -fL --retry 3 -C - -o "$out.part" "$url"
  echo "$sha  $out.part" | sha256sum -c -
  mv "$out.part" "$out"
}

mkdir -p "$DIR/bin" "$DIR/models"
fetch "https://github.com/ggml-org/llama.cpp/releases/download/$BUILD/llama-$BUILD-bin-ubuntu-x64.tar.gz" "$ARCHIVE_SHA" "$DIR/llama.tar.gz"
[ -x "$DIR/bin/llama-$BUILD/llama-server" ] || tar -xzf "$DIR/llama.tar.gz" -C "$DIR/bin"
fetch "https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/$MODEL" "$MODEL_SHA" "$DIR/models/$MODEL"

exec "$DIR/bin/llama-$BUILD/llama-server" -m "$DIR/models/$MODEL" --host 127.0.0.1 --port "$PORT" \
  --ctx-size 4096 --parallel 1 --reasoning off
