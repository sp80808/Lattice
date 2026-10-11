#!/usr/bin/env bash
# Run a Lattice Colab job as an atomic, interrupt-tolerant unit.
#
# Every job is a Colab session that:
#   * writes a run manifest BEFORE any work starts, so a killed session is
#     classified `interrupted` with a reason, never silently `lost`
#   * flushes each artifact to /content/out/<run_id>/ and announces it on
#     stdout, so the local wrapper recovers it even after the VM is released
#   * is `--resume` idempotent: completed steps are skipped and a re-run
#     finishes only the remainder
#
# The session is kept alive between calls so a killed job resumes in place;
# pass --release to stop it at the end.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
RESULTS="$ROOT_DIR/benchmarks/results/colab"
LOGS="$ROOT_DIR/.colab-logs"
LIB="$SCRIPT_DIR/lib/colab_persist.py"

usage() {
  cat <<'EOF'
Run a Lattice Colab job as an atomic, interrupt-tolerant unit.

Usage:
  ./scripts/colab-run.sh <job> [options] [-- extra args]

Jobs:
  teacher      Label the 240-case decision corpus with a Colab-hosted teacher
               and generate synthetic cases for the failing families.
  zero-shot    Measure every candidate student base on the 110-case holdout.
  sft          Fine-tune the router with LoRA (one base per call).
  overnight    Run autonomous overnight distillation, evaluation & feedback loop
               pairing Quantised GLM 5.3 Flash with SystemOne Tev decision router.

Options:
  --gpu T4              GPU accelerator (default T4)
  --session NAME        Reuse an existing session instead of creating one
  --timeout SECONDS     Per-exec-call timeout (default 900)
  --max-calls N         Cap on exec calls (default 12)
  --release             Stop the session when the job finishes
  --fresh               Start a new run instead of resuming the last one
  --env KEY=VALUE       Extra env vars injected into the remote kernel
  -h, --help            Show this help

Artifacts land in benchmarks/results/colab/<run_id>/ and logs in
.colab-logs/<session>.log. Re-running is safe: completed steps are skipped.
EOF
}

JOB="${1:-}"; shift || true
[ -z "$JOB" ] && { usage; exit 1; }

case "$JOB" in
  teacher) SCRIPT="scripts/colab_teacher_label.py" ;;
  zero-shot) SCRIPT="scripts/colab_zero_shot.py" ;;
  sft) SCRIPT="scripts/colab_train_router_v2.py" ;;
  overnight) SCRIPT="scripts/colab_overnight_loop.py" ;;
  *) echo "unknown job: $JOB"; usage; exit 1 ;;
esac

GPU="T4"; SESSION=""; KEEP=1; RELEASE=0; TIMEOUT=900; MAX_CALLS=12; FRESH=0; EXTRA_ENV=()
while [ $# -gt 0 ]; do
  case "$1" in
    --gpu) GPU="$2"; shift 2 ;;
    --session) SESSION="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --max-calls) MAX_CALLS="$2"; shift 2 ;;
    --release) RELEASE=1; shift ;;
    --fresh) FRESH=1; shift ;;
    --env) EXTRA_ENV+=("$2"); shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1"; usage; exit 1 ;;
  esac
done

TS="$(date -u +%Y%m%dT%H%M%SZ)"
SESSION="${SESSION:-lattice-$JOB-$TS}"
LOG="$LOGS/$SESSION.log"
mkdir -p "$LOGS" "$RESULTS"

# --- 1. session: reuse or create -------------------------------------------
if ! colab sessions 2>/dev/null | grep -q "\[$SESSION\]"; then
  echo "== creating session $SESSION (gpu=$GPU)"
  colab new -s "$SESSION" --gpu "$GPU"
fi
echo "== session $SESSION; log -> $LOG"

# --- 2. upload helper + corpus ---------------------------------------------
colab upload -s "$SESSION" "$LIB" /content/colab_persist.py
colab upload -s "$SESSION" "$ROOT_DIR/benchmarks/decisions/corpus.jsonl" /content/corpus.jsonl

# --- 3. resume run id from the previous log --------------------------------
RUN_ID=""
if [ "$FRESH" -eq 0 ] && [ -f "$LOG" ]; then
  RUN_ID="$( (grep -o '"runId": "[^"]*"' "$LOG" 2>/dev/null || true) | tail -1 | sed 's/.*: "//;s/"$//')"
fi

# --- 4. exec loop: bounded calls, resume between them ----------------------
CALL=0
while [ "$CALL" -lt "$MAX_CALLS" ]; do
  CALL=$((CALL + 1))
  ENVARGS=()
  [ -n "$RUN_ID" ] && ENVARGS+=(--env "LATTICE_RUN_ID=$RUN_ID")
  [ "$FRESH" -eq 1 ] && ENVARGS+=(--env "LATTICE_FRESH=1")
  if [ "${#EXTRA_ENV[@]}" -gt 0 ]; then
    for e in "${EXTRA_ENV[@]}"; do [ -n "$e" ] && ENVARGS+=(--env "$e"); done
  fi
  echo "== exec call $CALL/$MAX_CALLS (timeout=${TIMEOUT}s)"
  set +e
  colab exec -s "$SESSION" --timeout "$TIMEOUT" ${ENVARGS[@]+"${ENVARGS[@]}"} -f "$ROOT_DIR/$SCRIPT" 2>&1 | tee -a "$LOG"
  RC="${PIPESTATUS[0]}"
  set -e
  NEWID="$( (grep -o '"runId": "[^"]*"' "$LOG" 2>/dev/null || true) | tail -1 | sed 's/.*: "//;s/"$//')"
  [ -n "$NEWID" ] && RUN_ID="$NEWID"
  if [ -f "$LOG" ] && tail -80 "$LOG" | grep -q "JOB_COMPLETE"; then echo "== job complete"; break; fi
  if [ -f "$LOG" ] && tail -80 "$LOG" | grep -q "JOB_FAILED"; then echo "== job failed (rc=$RC)"; break; fi
  [ "$RC" -ne 0 ] && echo "== exec call returned $RC; resuming with the next call"
done

# --- 5. recover every artifact announced on stdout -------------------------
python3 "$SCRIPT_DIR/recover_colab_artifacts.py" "$SESSION" "$LOG" "$RESULTS" 2>&1 || true

# --- 6. summary ------------------------------------------------------------
echo
echo "== usage"
colab usage 2>&1 | sed 's/^/  /'
if [ -n "$RUN_ID" ]; then
  echo "== recovered artifacts ($RESULTS/$RUN_ID)"
  ls -1 "$RESULTS/$RUN_ID" 2>/dev/null | sed 's/^/  /' || true
fi
if [ "$RELEASE" -eq 1 ]; then
  echo "== releasing session $SESSION"
  colab stop -s "$SESSION"
else
  echo "== session $SESSION kept alive for resume; stop it later with: colab stop -s $SESSION"
fi