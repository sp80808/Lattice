# CI and merge checks

Lattice sells evidence over model confidence, so its own checks must never
report success when something failed. This page lists what has to be green
before a change merges to `main`.

## Required before merge

The `CI / build-test` job runs `scripts/ci-health.sh`, which runs:

| Check | Command | What it covers |
|---|---|---|
| build | `npm run build` | TypeScript project references |
| node tests | `npm test` | every package's `dist/index.test.js`, the CLI, and the example-checker regression tests |
| python tests | `npm run test:python` | Python SDK against a real daemon |
| examples | `npm run test:examples` | every example config and every runnable example, including the CLI demo in `--strict` mode |

Run the same thing locally before opening a PR:

```bash
npm run ci        # or scripts/ci-health.sh
```

It runs every step even when an earlier one fails and exits non-zero if any
step failed, so one run shows everything that is red.

`main` should be protected so that `CI / build-test` must pass before merge
(GitHub: Settings → Branches → branch protection rule for `main` → require
status checks → `build-test`).

## What counts as a failure

- **Node tests.** `npm test` runs through `scripts/run-node-tests.mjs`, which
  fails on failed and cancelled tests, and also on skipped and todo tests and
  on test files that report no tests. A skip that is genuinely intended goes in
  `scripts/test-allowlist.json` with a `reason`; entries that stop matching
  are reported as stale.
- **Examples.** `scripts/check-examples.sh` runs under `set -euo pipefail` and
  checks each step with `cmd; ok`, never `cmd && ok` (set -e ignores a failure
  on the left of `&&`, which is how it once printed "All examples passed" over
  a failing demo). In CI a missing `python3` fails the check instead of
  skipping the Python example.
- **CI steps.** The workflow runs every step with `bash -eo pipefail`.

`scripts/check-examples.test.mjs` breaks an example on purpose and asserts the
checker exits non-zero, so these rules are themselves tested.

## Writing scripts that cannot report false success

- Start with `set -euo pipefail`.
- Do not write `cmd && ok "..."` or `cmd || warn "..."` for a step whose
  failure should fail the script. Use `cmd; ok "..."`, or
  `if cmd; then ...; else ...; fi` when you need to keep going and record the
  failure.
- A step that is optional for people but required in CI should fail when
  `$CI` is set (see the Python example in `check-examples.sh`) or take a
  `--strict` flag (see `examples/demo/run-demo.sh`).
