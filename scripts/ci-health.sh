#!/usr/bin/env bash
# Run the checks main requires before merge, the same way CI does.
#
#   scripts/ci-health.sh          # or: npm run ci
#
# Every step runs even if an earlier one fails, so one run shows everything
# that is red. The script exits non-zero if any step failed.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

require_node
has python3 || die "python3 is required for the Python SDK tests"
cd "$LATTICE_ROOT"

STEPS=(
  "build|npm run build"
  "node tests|npm test"
  "python tests|npm run test:python"
  "examples|npm run test:examples"
)

failed=()
for step in "${STEPS[@]}"; do
  name="${step%%|*}" cmd="${step#*|}"
  info "$name: $cmd"
  # `if` keeps set -e from exiting so later steps still run; the status is
  # checked explicitly rather than with `cmd && ok`, which set -e ignores.
  if bash -c "$cmd"; then ok "$name"; else failed+=("$name"); warn "$name failed"; fi
done

echo
if [ "${#failed[@]}" -gt 0 ]; then
  die "CI health: ${#failed[@]} check(s) failed: ${failed[*]}"
fi
info "CI health: all ${#STEPS[@]} checks passed"
