#!/usr/bin/env bash
set -euo pipefail

# Serve the private MediX-R1 Qwen3-VL 2B export. Keep the checkpoint outside
# this repository; override MEDIX_2B_MODEL_PATH for another machine/export.
MODEL_PATH="${MEDIX_2B_MODEL_PATH:-/data1/zhl/medix/pro1/MediX-R1/training/checkpoints/medix-r1_2b_sft40k_dapo10k_retry/global_step_600/actor/huggingface}"
GPU_ID="${MEDIX_2B_GPU_ID:-0}"
PORT="${MEDIX_2B_PORT:-8010}"
MODEL_NAME="${MEDIX_2B_MODEL_NAME:-medix-r1-2b}"
VLLM_BIN="${VLLM_BIN:-/home/zhl/miniforge3/envs/medix-clean/bin/vllm}"

if [[ -z "${MEDIX_2B_API_KEY:-}" ]]; then
  echo "Set MEDIX_2B_API_KEY to a private random value before serving the model." >&2
  exit 1
fi

if [[ ! -f "$MODEL_PATH/config.json" || ! -f "$MODEL_PATH/model.safetensors" ]]; then
  echo "2B checkpoint not found or incomplete: $MODEL_PATH" >&2
  echo "Set MEDIX_2B_MODEL_PATH to the merged HuggingFace checkpoint directory." >&2
  exit 1
fi
if [[ ! -x "$VLLM_BIN" ]]; then
  echo "vLLM executable not found: $VLLM_BIN" >&2
  echo "Set VLLM_BIN or activate the medix-clean environment." >&2
  exit 1
fi

export CUDA_VISIBLE_DEVICES="$GPU_ID"
export VLLM_ALLOW_LONG_MAX_MODEL_LEN=1
export VLLM_API_KEY="$MEDIX_2B_API_KEY"

exec "$VLLM_BIN" serve "$MODEL_PATH" \
  --host 127.0.0.1 \
  --port "$PORT" \
  --served-model-name "$MODEL_NAME" \
  --dtype bfloat16 \
  --max-model-len "${MEDIX_2B_MAX_MODEL_LEN:-4096}" \
  --max-num-batched-tokens 4096 \
  --max-num-seqs 2 \
  --gpu-memory-utilization "${MEDIX_2B_GPU_MEMORY_UTILIZATION:-0.35}" \
  --mm-encoder-attn-backend TORCH_SDPA \
  --attention-backend TRITON_ATTN \
  --limit-mm-per-prompt '{"image":1}'
