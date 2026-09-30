#!/usr/bin/env bash
# End-to-end CLI walkthrough on a throwaway copy of examples/demo-repo.
#
#   examples/demo/run-demo.sh                   # offline: observe mode, test evidence only
#   examples/demo/run-demo.sh --preset ollama   # real search: local Qwen + qwen-code worker
#   examples/demo/run-demo.sh --keep            # keep the temp project for poking around
set -euo pipefail
. "$(dirname "$0")/../../scripts/lib.sh"

PRESET=observe KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --preset) PRESET="${2:?--preset needs a value}"; shift ;;
    --keep) KEEP=1 ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

require_node
require_built_cli
has git || die "git is required for the demo"

PROJECT="$(mktemp -d "${TMPDIR:-/tmp}/lattice-demo.XXXXXX")"
[ "$KEEP" = 1 ] || trap 'rm -rf "$PROJECT"' EXIT

info "Creating demo project in $PROJECT"
cp -R "$LATTICE_ROOT/examples/demo-repo/." "$PROJECT/"
find "$PROJECT" -name '._*' -delete 2>/dev/null || true
(
  cd "$PROJECT"
  git init -q
  git add -A
  git -c user.name=lattice-demo -c user.email=demo@lattice.invalid commit -qm "demo: broken add()"
)
ok "git repo with a failing test (add subtracts)"

info "lattice init --preset $PRESET   (verifier auto-detected from package.json)"
lattice -C "$PROJECT" init --preset "$PRESET"
git -C "$PROJECT" add .lattice
git -C "$PROJECT" -c user.name=lattice-demo -c user.email=demo@lattice.invalid commit -qm "lattice: add config"

info "lattice doctor"
lattice -C "$PROJECT" doctor --offline || warn "doctor found problems; an auto-mode run may fail"

info "lattice \"fix the failing add test\""
lattice -C "$PROJECT" "fix the failing add test" || warn "run failed (see hint above)"

info "lattice runs"
lattice -C "$PROJECT" runs

info "lattice show latest"
lattice -C "$PROJECT" show latest

info "lattice show latest --events"
lattice -C "$PROJECT" show latest --events

if [ "$KEEP" = 1 ]; then
  printf '\nProject kept at %s\n' "$PROJECT"
fi
