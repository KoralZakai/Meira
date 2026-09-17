#!/usr/bin/env bash
# Endpoint entrypoint — serves Lumi's parser over an OpenAI-compatible vLLM API.
#
# Two recipes, chosen by env:
#   A) Merged model (simplest): set MODEL_ID to the merged repo from Job B
#      (MERGE=1). No LoRA flags needed.
#   B) Base + LoRA adapter: leave MODEL_ID at the base student and set LORA_REPO
#      (or LORA_PATH) to Job B's adapter; it is loaded as a hot-swappable module
#      named $SERVED_MODEL_NAME, so clients calling that name get the fine-tune.
#
# The served name ($SERVED_MODEL_NAME) is the contract: it must match
# STUDENT_MODEL in Job C and EXPO_PUBLIC_NEBIUS_MODEL in the app.
set -euo pipefail

MODEL_ID="${MODEL_ID:-Qwen/Qwen3-4B-Instruct-2507}"
SERVED_MODEL_NAME="${SERVED_MODEL_NAME:-lumi-parser}"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8000}"
DTYPE="${DTYPE:-bfloat16}"
MAX_MODEL_LEN="${MAX_MODEL_LEN:-8192}"
GPU_MEMORY_UTILIZATION="${GPU_MEMORY_UTILIZATION:-0.90}"
MAX_LORA_RANK="${MAX_LORA_RANK:-16}"

# LoRA: prefer an explicit local LORA_PATH; else download LORA_REPO from the Hub.
LORA_PATH="${LORA_PATH:-}"
if [[ -z "${LORA_PATH}" && -n "${LORA_REPO:-}" ]]; then
  LORA_PATH="/adapter"
  echo "[serve] downloading LoRA adapter ${LORA_REPO} -> ${LORA_PATH}"
  huggingface-cli download "${LORA_REPO}" --local-dir "${LORA_PATH}" >/dev/null
fi

ARGS=(
  "${MODEL_ID}"
  --served-model-name "${SERVED_MODEL_NAME}"
  --host "${HOST}"
  --port "${PORT}"
  --dtype "${DTYPE}"
  --max-model-len "${MAX_MODEL_LEN}"
  --gpu-memory-utilization "${GPU_MEMORY_UTILIZATION}"
)

if [[ -n "${LORA_PATH}" ]]; then
  echo "[serve] enabling LoRA module '${SERVED_MODEL_NAME}' from ${LORA_PATH}"
  ARGS+=(
    --enable-lora
    --max-lora-rank "${MAX_LORA_RANK}"
    --lora-modules "${SERVED_MODEL_NAME}=${LORA_PATH}"
  )
fi

# Require a bearer token if one is provided (the key then stays server-side).
if [[ -n "${VLLM_API_KEY:-}" ]]; then
  ARGS+=(--api-key "${VLLM_API_KEY}")
fi

# Any extra raw vLLM flags can be appended via EXTRA_ARGS.
if [[ -n "${EXTRA_ARGS:-}" ]]; then
  # shellcheck disable=SC2206
  ARGS+=(${EXTRA_ARGS})
fi

echo "[serve] vllm serve ${ARGS[*]}"
exec vllm serve "${ARGS[@]}"
