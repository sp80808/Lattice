#!/usr/bin/env bash
# Point a project at a model provider: check the server/model, optionally pull
# it (Ollama), then write .lattice/config.json via `lattice init` and run doctor.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

usage() {
  cat <<'EOF'
Usage: scripts/setup-provider.sh [options]

  --provider P      ollama (default) | vllm | openai-compatible
  --model M         model name (ollama default: qwen3-coder)
  --base-url URL    OpenAI-compatible base URL (defaults: ollama :11434/v1, vllm :8000/v1)
  --api-key-env V   env var holding the API key (openai-compatible default: LATTICE_API_KEY)
  --agent A         coding agent preset: qwen-code (default) | opencode
  --verify "CMD"    verifier command (default: auto-detected from the project)
  --project DIR     project to configure (default: current directory)
  --pull            ollama only: pull the model if it is missing (large download)
  --force           overwrite an existing .lattice/config.json
  --dry-run         print what would run
  -h, --help        show this help

Examples:
  scripts/setup-provider.sh --project ~/code/app --pull
  scripts/setup-provider.sh --provider vllm --model Qwen/Qwen3-Coder-30B-A3B-Instruct
  MY_KEY=... scripts/setup-provider.sh --provider openai-compatible \
      --base-url https://api.example.com/v1 --model some-model --api-key-env MY_KEY
EOF
}

PROVIDER=ollama MODEL="" BASE_URL="" API_KEY_ENV="" AGENT="" VERIFY="" PROJECT="$PWD" PULL=0 FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --provider) PROVIDER="${2:?--provider needs a value}"; shift ;;
    --model) MODEL="${2:?--model needs a value}"; shift ;;
    --base-url) BASE_URL="${2:?--base-url needs a value}"; shift ;;
    --api-key-env) API_KEY_ENV="${2:?--api-key-env needs a value}"; shift ;;
    --agent) AGENT="${2:?--agent needs a value}"; shift ;;
    --verify) VERIFY="${2:?--verify needs a value}"; shift ;;
    --project) PROJECT="${2:?--project needs a value}"; shift ;;
    --pull) PULL=1 ;;
    --force) FORCE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
  shift
done

require_node
require_built_cli
[ -d "$PROJECT" ] || die "project directory not found: $PROJECT"
PROJECT="$(cd "$PROJECT" && pwd)"

probe() { curl -sf --max-time 3 "$@" >/dev/null 2>&1; }

case "$PROVIDER" in
  ollama)
    MODEL="${MODEL:-qwen3-coder}"
    BASE_URL="${BASE_URL:-http://127.0.0.1:11434/v1}"
    OLLAMA_HOST_URL="${BASE_URL%/v1}"
    info "Checking Ollama at $OLLAMA_HOST_URL"
    has ollama || warn "ollama CLI not found: install from https://ollama.com/download"
    if probe "$OLLAMA_HOST_URL/api/tags"; then
      ok "server is running"
      if curl -sf --max-time 3 "$OLLAMA_HOST_URL/api/tags" | grep -q "\"name\":\"$MODEL[\":]"; then
        ok "model $MODEL is available"
      elif [ "$PULL" = 1 ]; then
        has ollama || die "--pull needs the ollama CLI"
        run ollama pull "$MODEL"
      else
        warn "model $MODEL is not pulled yet: run \`ollama pull $MODEL\` or re-run with --pull"
      fi
    else
      warn "Ollama is not reachable: start it with \`ollama serve\` (or open the Ollama app)"
      [ "$PULL" = 1 ] && warn "skipping --pull until the server is running"
    fi
    ;;
  vllm)
    [ -n "$MODEL" ] || die "--provider vllm needs --model (the served model name)"
    BASE_URL="${BASE_URL:-http://127.0.0.1:8000/v1}"
    info "Checking vLLM at $BASE_URL"
    if probe "$BASE_URL/models"; then ok "server is running"; else
      warn "vLLM is not reachable: start it with \`vllm serve $MODEL --port 8000\`"
    fi
    ;;
  openai-compatible)
    [ -n "$BASE_URL" ] || die "--provider openai-compatible needs --base-url"
    [ -n "$MODEL" ] || die "--provider openai-compatible needs --model"
    API_KEY_ENV="${API_KEY_ENV:-LATTICE_API_KEY}"
    info "Checking $BASE_URL"
    if [ -z "${!API_KEY_ENV:-}" ]; then
      warn "\$$API_KEY_ENV is not set; export it before running lattice (the key is never written to config)"
    else
      ok "\$$API_KEY_ENV is set"
    fi
    ;;
  *) die "unknown provider: $PROVIDER (expected ollama, vllm or openai-compatible)" ;;
esac

AGENT_BIN=qwen
[ "${AGENT:-qwen-code}" = opencode ] && AGENT_BIN=opencode
if ! has "$AGENT_BIN"; then
  case "$AGENT_BIN" in
    qwen) warn "coding agent \`qwen\` not found: npm install -g @qwen-code/qwen-code" ;;
    opencode) warn "coding agent \`opencode\` not found: see https://opencode.ai" ;;
  esac
fi

info "Writing Lattice config for $PROJECT"
args=(-C "$PROJECT" init --preset "$PROVIDER" --model "$MODEL" --base-url "$BASE_URL")
[ -n "$API_KEY_ENV" ] && args+=(--api-key-env "$API_KEY_ENV")
[ -n "$AGENT" ] && args+=(--agent "$AGENT")
[ -n "$VERIFY" ] && args+=(--verify "$VERIFY")
[ "$FORCE" = 1 ] && args+=(--force)
run node "$LATTICE_CLI" "${args[@]}"

if [ "$DRY_RUN" = 0 ]; then
  info "Running doctor"
  lattice -C "$PROJECT" doctor || warn "fix the ✗ items above, then re-run: lattice -C \"$PROJECT\" doctor"
fi
