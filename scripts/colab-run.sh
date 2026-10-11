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

GPU="T4"; SESSION=""; KEEP=1; RELEASE=0; TIMEOUT=900; MAX_CALLS=12; FRESH=0; EXTRA_ENV=(); EXTRA_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --gpu) GPU="$2"; shift 2 ;;
    --session) SESSION="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --max-calls) MAX_CALLS="$2"; shift 2 ;;
    --release) RELEASE=1; shift ;;
    --fresh) FRESH=1; shift ;;
    --env) EXTRA_ENV+=("$2"); shift 2 ;;
    --) shift; EXTRA_ARGS=("$@"); break ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1"; usage; exit 1 ;;
  esac
done

TS="$(date -u +%Y%m%dT%H%M%SZ)"
SESSION="${SESSION:-lattice-$JOB-$TS}"
LOG="$LOGS/$SESSION.log"
mkdir -p "$LOGS" "$RESULTS"

# --- 1. session: query status safely (separate failure from absence) --------
SESSION_LIST=""
if ! SESSION_LIST="$(colab sessions 2>&1)"; then
  echo "ERROR: 'colab sessions' failed (exit $?):" >&2
  echo "$SESSION_LIST" >&2
  exit 1
fi

if ! echo "$SESSION_LIST" | grep -q "\[$SESSION\]"; then
  echo "== creating session $SESSION (gpu=$GPU)"
  if ! colab new -s "$SESSION" --gpu "$GPU"; then
    echo "ERROR: failed to create session $SESSION" >&2
    exit 1
  fi
fi
echo "== session $SESSION; log -> $LOG"

# --- 2. upload helper + corpus ---------------------------------------------
if ! colab upload -s "$SESSION" "$LIB" /content/colab_persist.py; then
  echo "ERROR: failed to upload $LIB" >&2
  exit 1
fi
if ! colab upload -s "$SESSION" "$ROOT_DIR/benchmarks/decisions/corpus.jsonl" /content/corpus.jsonl; then
  echo "ERROR: failed to upload corpus.jsonl" >&2
  exit 1
fi

# --- 3. resume run id from the previous log --------------------------------
RUN_ID=""
if [ "$FRESH" -eq 0 ] && [ -f "$LOG" ]; then
  RUN_ID="$( (grep -o '"runId": "[^"]*"' "$LOG" 2>/dev/null || true) | tail -1 | sed 's/.*: "//;s/"$//')"
fi

# --- 4. exec loop: bounded calls, resume between them ----------------------
CALL=0
JOB_STATUS=""
LOG_LINES_BEFORE=0
[ -f "$LOG" ] && LOG_LINES_BEFORE=$(wc -l < "$LOG" | tr -d ' ')

while [ "$CALL" -lt "$MAX_CALLS" ]; do
  CALL=$((CALL + 1))
  ENVARGS=()
  [ -n "$RUN_ID" ] && ENVARGS+=(--env "LATTICE_RUN_ID=$RUN_ID")
  [ "$FRESH" -eq 1 ] && ENVARGS+=(--env "LATTICE_FRESH=1")
  if [ "${#EXTRA_ENV[@]}" -gt 0 ]; then
    for e in "${EXTRA_ENV[@]}"; do [ -n "$e" ] && ENVARGS+=(--env "$e"); done
  fi
  echo "== exec call $CALL/$MAX_CALLS (timeout=${TIMEOUT}s)"

  CALL_START_LINE=$LOG_LINES_BEFORE
  set +e
  colab exec -s "$SESSION" --timeout "$TIMEOUT" ${ENVARGS[@]+"${ENVARGS[@]}"} -f "$ROOT_DIR/$SCRIPT" ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"} 2>&1 | tee -a "$LOG"
  RC="${PIPESTATUS[0]}"
  set -e

  LOG_LINES_NOW=$(wc -l < "$LOG" | tr -d ' ')
  CALL_OUTPUT=""
  if [ "$LOG_LINES_NOW" -gt "$CALL_START_LINE" ]; then
    CALL_OUTPUT="$(tail -n +"$((CALL_START_LINE + 1))" "$LOG" 2>/dev/null || true)"
  fi
  LOG_LINES_BEFORE=$LOG_LINES_NOW

  NEWID="$( (echo "$CALL_OUTPUT" | grep -o '"runId": "[^"]*"' 2>/dev/null || true) | tail -1 | sed 's/.*: "//;s/"$//')"
  [ -n "$NEWID" ] && RUN_ID="$NEWID"

  if echo "$CALL_OUTPUT" | grep -q "JOB_COMPLETE"; then
    JOB_STATUS="completed"
    echo "== job complete"
    break
  fi
  if echo "$CALL_OUTPUT" | grep -q '"outcome": "completed"'; then
    JOB_STATUS="completed"
    echo "== job complete (manifest outcome)"
    break
  fi
  if echo "$CALL_OUTPUT" | grep -q "JOB_FAILED"; then
    JOB_STATUS="failed"
    echo "== job failed (rc=$RC)"
    break
  fi
  if echo "$CALL_OUTPUT" | grep -q '"outcome": "interrupted"'; then
    JOB_STATUS="interrupted"
    echo "== job interrupted (manifest outcome)"
    break
  fi

  [ "$RC" -ne 0 ] && echo "== exec call returned $RC; resuming with the next call"
done

if [ -z "$JOB_STATUS" ]; then
  JOB_STATUS="exhausted"
  echo "== job exhausted $MAX_CALLS calls without completion marker"
fi

# --- 5. recover every artifact announced on stdout -------------------------
RECOVERY_ARGS=("$SESSION" "$LOG" "$RESULTS")
[ -n "$RUN_ID" ] && RECOVERY_ARGS=(--run-id "$RUN_ID" "$SESSION" "$LOG" "$RESULTS")
set +e
python3 "$SCRIPT_DIR/recover_colab_artifacts.py" "${RECOVERY_ARGS[@]}"
RECOVERY_EXIT=$?
set -e
if [ "$RECOVERY_EXIT" -ne 0 ]; then
  echo "ERROR: artifact recovery reported errors (exit $RECOVERY_EXIT)" >&2
fi

# --- 6. summary ------------------------------------------------------------
echo
echo "== usage"
colab usage 2>&1 | sed 's/^/  /' || true
if [ -n "$RUN_ID" ]; then
  echo "== recovered artifacts ($RESULTS/$RUN_ID)"
  ls -1 "$RESULTS/$RUN_ID" 2>/dev/null | sed 's/^/  /' || true
fi

if [ "$RELEASE" -eq 1 ]; then
  echo "== releasing session $SESSION"
  colab stop -s "$SESSION" 2>&1 || true
else
  echo "== session $SESSION kept alive for resume; stop it later with: colab stop -s $SESSION"
fi

# --- 7. final exit gate ----------------------------------------------------
if [ "$JOB_STATUS" != "completed" ]; then
  echo "ERROR: job did not complete successfully (status=$JOB_STATUS)" >&2
  exit 1
fi
if [ "$RECOVERY_EXIT" -ne 0 ]; then
  echo "ERROR: artifact recovery failed (exit $RECOVERY_EXIT)" >&2
  exit 1
fi
exit 0