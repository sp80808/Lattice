#!/usr/bin/env python3
"""Lattice decision-router zero-shot base matrix (Colab GPU session).

Measures every candidate student base on the same 110-case holdout with the
byte-identical decision contract from scripts/decision-bench.py, so results are
directly comparable to the local baselines (tev1:0.8b@systemone 87.3%,
qwen3:1.7b@chat 37.3%) and to later fine-tuned runs.

Matrix (env ROUTER_BASES overrides):
  Qwen/Qwen3-0.6B               latency floor
  Qwen/Qwen3-1.7B               small-student candidate
  Qwen/Qwen3-4B-Instruct-2507   4B candidate (#1 post-FT in distil-labs study)
  Qwen/Qwen2.5-Coder-1.5B       coder-flavoured latency floor

No training happens here; this is the cheap, decisive experiment that picks
the student by measurement instead of release notes. Every base's metrics are
flushed as soon as it finishes, so a session killed mid-matrix still yields
the bases it completed.

Run standalone or via scripts/colab-run.sh zero-shot.
"""
import argparse
import datetime as dt
import json
import os
import re
import statistics
import subprocess
import sys
import time
import traceback
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # local: scripts/
if Path("/content/colab_persist.py").exists():             # remote: uploaded helper
    sys.path.insert(0, "/content")
try:
    from lib.colab_persist import ColabRun
except ImportError:
    from colab_persist import ColabRun

# --- contract copied verbatim from scripts/decision-bench.py (do not drift;
# --- scripts/check_colab_contracts.py guards this block) ---
ABSTAIN_ID = 'abstain'
INSTRUCTIONS = 'Select the single best next action for the engineering task.'
SUMMARY = {
    'inspect': 'Inspect code, tests, logs, or error evidence before editing.',
    'edit': 'Apply an identified code fix or patch based on evidence.',
    'run_tests': 'Run tests, linters, or typechecks on unverified code changes.',
    'finish': 'Complete the task after all checks have passed and changes are reviewed.',
    'escalate': 'Escalate, ask the user, or stop for missing permission or safety risk.',
    'none': 'No task specified, empty request, or meaningless instructions.',
    ABSTAIN_ID: 'Evidence is insufficient or ambiguous; do not act.',
}
CONTRACT = {
    'selected': 'one choice id from the valid choice IDs',
    'scores': 'object mapping every valid choice id to a non-negative number',
    'confidence': 'optional number from 0 to 1',
}
# --- end contract ---

DEFAULT_BASES = [
    'Qwen/Qwen3-0.6B',
    'Qwen/Qwen3-1.7B',
    'Qwen/Qwen3-4B-Instruct-2507',
    'Qwen/Qwen2.5-Coder-1.5B',
]
TEMPLATE_KWARGS = {'enable_thinking': False}


def system_for(ids):
    # same construction as decision-bench.ask_chat: interpolate ids into the line,
    # never .format() the whole block (the contract JSON contains braces)
    lines = [
        'You are Lattice\'s bounded decision engine.',
        'Use only the supplied state, question and choices.',
        'Do not invent repository facts.',
        f'Return JSON only matching this contract: {json.dumps(CONTRACT)}.',
        f'Valid choice IDs: {", ".join(ids)}.',
        f'If evidence is insufficient, select {ABSTAIN_ID} when it is offered.',
    ]
    return '\n'.join(lines)


def choices_for(case, full_set):
    ids = list(case['allow']) if not full_set else ['inspect', 'edit', 'run_tests', 'finish', 'escalate', 'none']
    if case['acceptAbstain'] and ABSTAIN_ID not in ids:
        ids.append(ABSTAIN_ID)
    return {id: SUMMARY[id] for id in ids}


def build_prompt(case):
    """Byte-identical to decision-bench.ask_chat prompt construction."""
    criteria = choices_for(case, False)
    ids = list(criteria)
    system = system_for(ids)
    user = json.dumps({
        'mode': 'choice',
        'state': f"{case['state']}\nEvidence: {case['evidence']}",
        'question': INSTRUCTIONS,
        'choices': [{'id': id, 'summary': text} for id, text in criteria.items()],
    }, ensure_ascii=False)
    return system, user, ids


def is_correct(case, selected, offered):
    if selected is None:
        return False, 'no_selection'
    if selected not in offered:
        return False, 'invalid_choice'
    if selected == ABSTAIN_ID:
        return case['acceptAbstain'], 'abstain' if case['acceptAbstain'] else 'abstain_when_action_required'
    if selected == case['expected']:
        return True, 'correct'
    return False, 'wrong_action'


def slug(model_id):
    return re.sub(r'[^A-Za-z0-9._-]+', '_', model_id)


def load_dtype(torch):
    """T4 (sm_75) cannot do bfloat16; fp16 there, bf16 on Ampere+."""
    if not torch.cuda.is_available():
        return torch.float32
    capability = torch.cuda.get_device_capability()
    return torch.bfloat16 if capability[0] >= 8 else torch.float16


def load_base(base, four_bit):
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(base)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    kwargs = {'device_map': 'auto', 'dtype': load_dtype(torch)}
    if four_bit:
        from transformers import BitsAndBytesConfig
        kwargs['quantization_config'] = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_compute_dtype=load_dtype(torch))
    model = AutoModelForCausalLM.from_pretrained(base, **kwargs)
    model.config.use_cache = False
    return tok, model


def evaluate(model, tok, cases, max_new_tokens):
    import torch

    model.eval()
    rows = []
    with torch.inference_mode():
        for index, case in enumerate(cases, 1):
            system, user, ids = build_prompt(case)
            prompt = tok.apply_chat_template(
                [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}],
                tokenize=False, add_generation_prompt=True, chat_template_kwargs=TEMPLATE_KWARGS)
            inputs = tok(prompt, return_tensors='pt').to(model.device)
            start = time.perf_counter()
            out = model.generate(**inputs, max_new_tokens=max_new_tokens, do_sample=False)
            latency_ms = round((time.perf_counter() - start) * 1000, 1)
            reply = tok.decode(out[0][inputs.input_ids.shape[1]:], skip_special_tokens=True).strip()
            match = re.search(r'\{.*\}', reply, re.S)
            selected, confidence = None, None
            if match:
                try:
                    parsed = json.loads(match.group(0))
                    selected = parsed.get('selected')
                    confidence = parsed.get('confidence')
                except ValueError:
                    selected = None
            correct, kind = is_correct(case, selected, ids)
            rows.append({'case': case['id'], 'family': case['family'], 'risk': case['risk'],
                         'expected': case['expected'], 'predicted': selected, 'kind': kind,
                         'correct': correct, 'offered': ids, 'confidence': confidence,
                         'latencyMs': latency_ms, 'raw': reply[:160]})
            if index % 25 == 0 or index == len(cases):
                print(f'  [{index}/{len(cases)}] last={case["id"]} {kind}', flush=True)
    return rows


def percentile(values, pct):
    if not values:
        return None
    values = sorted(values)
    index = min(len(values) - 1, max(0, int(round((pct / 100) * (len(values) - 1)))))
    return round(values[index], 1)


def summarize(rows, model_id, method):
    n = len(rows)
    if not n:
        return {'model': model_id, 'cases': 0, 'accuracy': None}
    correct = sum(1 for r in rows if r['correct'])
    families = {}
    for r in rows:
        families.setdefault(r['family'], []).append(r)
    latencies = [r['latencyMs'] for r in rows if r.get('latencyMs') is not None]
    confidences = [r['confidence'] for r in rows if isinstance(r.get('confidence'), (int, float))]
    buckets = {}
    for r in rows:
        if not isinstance(r.get('confidence'), (int, float)):
            continue
        bucket = f'{min(1.0, max(0.0, r["confidence"])):.1f}'
        key = ['0.0-0.2', '0.2-0.4', '0.4-0.6', '0.6-0.8', '0.8-1.0'][min(4, int(float(bucket) * 5))]
        buckets.setdefault(key, []).append(r)
    high = [r for r in rows if r['risk'] == 'high']
    return {
        'model': model_id,
        'method': method,
        'cases': n,
        'correct': correct,
        'accuracy': round(correct / n, 4),
        'abstainRate': round(sum(1 for r in rows if r['predicted'] == ABSTAIN_ID) / n, 4),
        'highRiskAccuracy': round(sum(1 for r in high if r['correct']) / max(1, len(high)), 4),
        'invalidRate': round(sum(1 for r in rows if r['kind'] in ('invalid_choice', 'no_selection')) / n, 4),
        'byFamily': {f: {'n': len(v), 'accuracy': round(sum(1 for r in v if r['correct']) / len(v), 4)}
                     for f, v in sorted(families.items())},
        'calibration': {k: {'n': len(v), 'accuracy': round(sum(1 for r in v if r['correct']) / len(v), 4)}
                        for k, v in sorted(buckets.items())},
        'meanConfidence': round(statistics.mean(confidences), 4) if confidences else None,
        'latencyMs': {'p50': percentile(latencies, 50), 'p95': percentile(latencies, 95),
                      'mean': round(statistics.mean(latencies), 1) if latencies else None},
        'timestamp': dt.datetime.now(dt.timezone.utc).isoformat(),
    }


def main():
    env = os.environ.get
    ap = argparse.ArgumentParser()
    ap.add_argument('--bases', '--models', nargs='+', default=(env('ROUTER_BASES') or ' '.join(DEFAULT_BASES)).split())
    ap.add_argument('--corpus', default=env('LATTICE_CORPUS', '/content/corpus.jsonl'))
    ap.add_argument('--split', default='holdout', choices=['all', 'train', 'holdout'])
    ap.add_argument('--max-new-tokens', type=int, default=int(env('ROUTER_MAX_NEW_TOKENS', '96')))
    ap.add_argument('--four-bit', default=env('ROUTER_FOUR_BIT', 'never'), choices=['auto', 'always', 'never'])
    ap.add_argument('--fresh', action='store_true', help='ignore LATTICE_RUN_ID and start a new run')
    args, _unknown = ap.parse_known_args()  # colab_kernel_launcher injects its own -f flag
    if args.fresh:
        os.environ.pop('LATTICE_RUN_ID', None)

    import torch

    corpus = Path(args.corpus)
    if not corpus.exists():
        corpus = Path(__file__).resolve().parents[1] / 'benchmarks' / 'decisions' / 'corpus.jsonl'
    rows = [json.loads(line) for line in corpus.read_text(encoding='utf-8').splitlines() if line.strip()]
    cases = rows if args.split == 'all' else [r for r in rows if r['split'] == args.split]
    print(f'corpus: {len(cases)} cases (split={args.split}) from {corpus}', flush=True)

    run = ColabRun('zero-shot')
    gpu = torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'cpu'
    run.emit('config.json', {
        'job': 'zero-shot', 'bases': args.bases, 'split': args.split,
        'corpus': str(corpus), 'corpusCases': len(rows), 'gpu': gpu,
        'torch': torch.__version__, 'maxNewTokens': args.max_new_tokens,
    }, kind='config')

    summaries = []
    for base in args.bases:
        name = f'zero-shot-{slug(base)}.json'
        if run.is_done(name):
            print(f'skip {base}: {name} already emitted (resume)', flush=True)
            summaries.append(json.loads(run.path_for(name).read_text(encoding='utf-8')))
            continue
        print(f'\n================ ZERO-SHOT: {base} ({gpu}) ================', flush=True)
        four_bit = args.four_bit == 'always' or (
            args.four_bit == 'auto' and torch.cuda.is_available()
            and torch.cuda.get_device_properties(0).total_memory < 24 * 1024 ** 3)
        try:
            tok, model = load_base(base, four_bit)
        except Exception as err:
            print(f'  load failed: {type(err).__name__}: {str(err)[:300]}', flush=True)
            run.emit(f'zero-shot-{slug(base)}.error.json',
                     {'model': base, 'error': f'{type(err).__name__}: {err}'[:2000]}, kind='error')
            continue
        rows_out = evaluate(model, tok, cases, args.max_new_tokens)
        summary = summarize(rows_out, base, f'zero-shot holdout eval, 4bit={four_bit}')
        run.emit(name, summary)
        run.append_jsonl(f'zero-shot-{slug(base)}.rows.jsonl', rows_out, stream=False)
        print(f'  {base}: {summary["accuracy"]:.1%} '
              f'(invalid={summary["invalidRate"]:.1%}, p50={summary["latencyMs"]["p50"]}ms)', flush=True)
        summaries.append(summary)
        del model, tok
        torch.cuda.empty_cache()

    matrix = {'runId': run.run_id, 'split': args.split, 'cases': len(cases),
              'gpu': gpu, 'bases': summaries,
              'best': max((s['accuracy'] for s in summaries if s.get('accuracy') is not None), default=None)}
    run.emit('zero-shot-matrix.json', matrix)
    if args.bases and len(summaries) == len(args.bases):
        run.complete(matrix)
        print('JOB_COMPLETE', flush=True)
    else:
        run.interrupt('some bases failed to load or evaluate; see per-base error artifacts')
        print('JOB_FAILED', flush=True)
        sys.exit(1)


if __name__ == '__main__':
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        reason = traceback.format_exc(limit=6)
        print(reason, flush=True)
        print('JOB_FAILED', flush=True)
        sys.exit(1)
