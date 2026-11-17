#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL_PORT="${MEDIX_2B_PORT:-8010}"
APP_PORT="${MEDIX_2B_APP_PORT:-8009}"
MODEL_NAME="${MEDIX_2B_MODEL_NAME:-medix-r1-2b}"

cd "$ROOT"
if [[ ! -f frontend/dist/index.html ]]; then
  echo "Frontend build missing. Run: cd frontend && npm ci && npm run build" >&2
  exit 1
fi
if [[ ! -x .venv/bin/uvicorn ]]; then
  echo "Backend environment missing. Install backend/requirements.txt in .venv first." >&2
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required to generate local access keys." >&2
  exit 1
fi

umask 077
mkdir -p .local
APP_TOKEN="$(openssl rand -hex 32)"
MODEL_KEY="$(openssl rand -hex 32)"
printf '%s\n' "$APP_TOKEN" > .local/access_token

model_pid=""
app_pid=""
cleanup() {
  trap - EXIT INT TERM
  [[ -z "$app_pid" ]] || kill "$app_pid" 2>/dev/null || true
  [[ -z "$model_pid" ]] || kill "$model_pid" 2>/dev/null || true
  [[ -z "$app_pid" ]] || wait "$app_pid" 2>/dev/null || true
  [[ -z "$model_pid" ]] || wait "$model_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

MEDIX_2B_API_KEY="$MODEL_KEY" scripts/serve_local_2b.sh &
model_pid=$!
echo "Loading MediX-R1 2B on GPU ${MEDIX_2B_GPU_ID:-0}; waiting for model endpoint..."
model_ready=0
for ((attempt = 0; attempt < 180; attempt++)); do
  if curl --silent --show-error --fail --max-time 2 \
      --header "Authorization: Bearer $MODEL_KEY" \
      "http://127.0.0.1:${MODEL_PORT}/v1/models" >/dev/null 2>&1; then
    model_ready=1
    break
  fi
  if ! kill -0 "$model_pid" 2>/dev/null; then
    echo "Model server stopped before becoming ready." >&2
    exit 1
  fi
  sleep 2
done
if [[ "$model_ready" != 1 ]] || ! kill -0 "$model_pid" 2>/dev/null; then
  echo "Model server did not become ready within six minutes." >&2
  exit 1
fi

MEDIX_MODE=live \
MEDIX_ACCESS_TOKEN="$APP_TOKEN" \
MEDIX_MODEL_BASE_URL="http://127.0.0.1:${MODEL_PORT}/v1" \
MEDIX_MODEL_NAME="$MODEL_NAME" \
MEDIX_MODEL_API_KEY="$MODEL_KEY" \
MEDIX_MODEL_SUPPORTS_VISION=true \
  .venv/bin/uvicorn backend.app.main:app --host 127.0.0.1 --port "$APP_PORT" --no-access-log &
app_pid=$!
echo "MediX Care 2B: http://127.0.0.1:${APP_PORT}"
echo "Access token: $ROOT/.local/access_token (private local file)"
wait -n "$model_pid" "$app_pid"
