# Shared helpers for Lattice setup scripts. Source, don't execute.
# shellcheck shell=bash

LATTICE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LATTICE_CLI="$LATTICE_ROOT/apps/cli/dist/index.js"
DRY_RUN="${DRY_RUN:-0}"

info() { printf '\033[1m==>\033[0m %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

has() { command -v "$1" >/dev/null 2>&1; }

# Print a command, then run it unless --dry-run was given.
run() {
  printf '  \033[2m$ %s\033[0m\n' "$(printf '%q ' "$@")"
  [ "$DRY_RUN" = 1 ] || "$@"
}

lattice() { node "$LATTICE_CLI" "$@"; }

require_built_cli() {
  [ -f "$LATTICE_CLI" ] || die "Lattice CLI is not built; run scripts/bootstrap.sh (or npm run build) first"
}

require_node() {
  has node || die "Node.js >= 22 is required (https://nodejs.org)"
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 22 ] || die "Node.js >= 22 is required (found $(node --version))"
}
