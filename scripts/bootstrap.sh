#!/usr/bin/env bash
# Set up a Lattice development checkout: toolchain checks, install, build,
# tests and a CLI smoke test.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

usage() {
  cat <<'EOF'
Usage: scripts/bootstrap.sh [options]

  --skip-tests   build only; do not run the test suites
  --python       also run the Python SDK integration tests (needs python3)
  --link         `npm link` the CLI so `lattice` is on your PATH (writes to the global npm prefix)
  --dry-run      print what would run
  -h, --help     show this help
EOF
}

SKIP_TESTS=0 PYTHON=0 LINK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-tests) SKIP_TESTS=1 ;;
    --python) PYTHON=1 ;;
    --link) LINK=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
  shift
done

cd "$LATTICE_ROOT"

info "Checking toolchain"
require_node
ok "node $(node --version)"
has npm || die "npm is required"
ok "npm $(npm --version)"
if has git; then ok "$(git --version)"; else warn "git not found: worktree isolation for coding agents needs it"; fi
if [ "$PYTHON" = 1 ]; then
  has python3 || die "--python needs python3"
  ok "$(python3 --version)"
fi

info "Installing dependencies"
run npm install --no-audit --no-fund

info "Building"
run npm run build

if [ "$SKIP_TESTS" = 0 ]; then
  info "Running tests"
  run npm test
  if [ "$PYTHON" = 1 ]; then
    run python3 -m unittest discover -s sdks/python/tests
  fi
fi

info "Smoke-testing the CLI"
if [ "$DRY_RUN" = 1 ]; then
  run node "$LATTICE_CLI" --version
else
  ok "lattice $(lattice --version)"
  lattice doctor --offline || warn "doctor reported problems (expected until you run lattice init in a project)"
fi

if [ "$LINK" = 1 ]; then
  info "Linking the CLI onto PATH"
  (cd apps/cli && run npm link)
  has lattice && ok "lattice -> $(command -v lattice)"
fi

cat <<EOF

Next steps:
  scripts/setup-provider.sh --project /path/to/repo      # local Qwen via Ollama (default)
  scripts/setup-agents.sh --client claude --project /path/to/repo
  node $LATTICE_CLI --help
EOF
