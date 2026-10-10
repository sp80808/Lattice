#!/usr/bin/env python3
"""Lattice decision-routing benchmark: exact per-case predictions across models.

Measures the *decision* layer, not whole-task completion: for each held-out case
the router must pick the single correct next action. Whole-task success is a
separate measurement (`lattice bench`); both are required, because a chain of
individually correct decisions can still fail to deliver a task.

Per case the harness:
  1. applies deterministic eligibility filtering (only `allow` actions are
     offered, unless --full-choice-set ablates this),
  2. offers an abstention choice when the case accepts abstention,
  3. records the exact prediction, confidence, latency and usage.

Protocols:
  chat       OpenAI-compatible /chat/completions using Lattice's bounded
             decision contract (the generic routing path)
  systemone  Ollama-style /systemone typed choice question (tev1's API)

Usage:
  python3 scripts/decision-bench.py --models qwen3:1.7b tev1:0.8b:systemone
  python3 scripts/decision-bench.py --models qwen3:1.7b --split holdout --ablation
"""
import argparse
import datetime as dt
import json
import math
import random
import re
import statistics
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

CORPUS = Path(__file__).resolve().parents[1] / 'benchmarks' / 'decisions' / 'corpus.jsonl'
RESULTS = Path(__file__).resolve().parents[1] / 'benchmarks' / 'results'
DEFAULT_BASE = 'http://127.0.0.1:11434/v1'
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


def request(url, body=None, timeout=120):
    payload = json.dumps(body).encode() if body is not None else None
    headers = {'Content-Type': 'application/json'} if payload else {}
    req = Request(url, data=payload, headers=headers, method='POST' if payload else 'GET')
    start = time.perf_counter()
    try:
        with urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode()), round((time.perf_counter() - start) * 1000, 1), None
    except (HTTPError, URLError, OSError, ValueError) as err:
        detail = ''
        if isinstance(err, HTTPError):
            try:
                detail = err.read().decode(errors='replace')[:400]
            except Exception:
                pass
        return None, round((time.perf_counter() - start) * 1000, 1), f'{err} {detail}'.strip()


def wilson95(successes, n):
    if n == 0:
        return [0.0, 1.0]
    z = 1.96
    p = successes / n
    d = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / d
    margin = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(max(0.0, centre - margin), 4), round(min(1.0, centre + margin), 4)]


def percentile(values, pct):
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, math.ceil(pct / 100 * len(ordered)) - 1))
    return round(ordered[index], 1)


def choices_for(case, full_set):
    ids = list(case['allow']) if not full_set else ['inspect', 'edit', 'run_tests', 'finish', 'escalate', 'none']
    if case['acceptAbstain'] and ABSTAIN_ID not in ids:
        ids.append(ABSTAIN_ID)
    return {id: SUMMARY[id] for id in ids}


def ask_chat(base_url, model, case, full_set, keep_alive, timeout):
    criteria = choices_for(case, full_set)
    ids = list(criteria)
    system = '\n'.join([
        'You are Lattice\'s bounded decision engine.',
        'Use only the supplied state, question and choices.',
        'Do not invent repository facts.',
        f'Return JSON only matching this contract: {json.dumps(CONTRACT)}.',
        f'Valid choice IDs: {", ".join(ids)}.',
        f'If evidence is insufficient, select {ABSTAIN_ID} when it is offered.',
    ])
    user = json.dumps({
        'mode': 'choice',
        'state': f"{case['state']}\nEvidence: {case['evidence']}",
        'question': INSTRUCTIONS,
        'choices': [{'id': id, 'summary': text} for id, text in criteria.items()],
    }, ensure_ascii=False)
    body, ms, err = request(f"{base_url.rstrip('/')}/chat/completions", {
        'model': model,
        'temperature': 0,
        'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}],
        'response_format': {'type': 'json_object'},
    }, timeout=timeout)
    if err:
        return {'ok': False, 'error': err, 'latencyMs': ms}
    content = (((body or {}).get('choices') or [{}])[0].get('message') or {}).get('content') or ''
    parsed = None
    match = re.search(r'\{.*\}', content, re.S)
    if match:
        try:
            parsed = json.loads(match.group(0))
        except ValueError:
            parsed = None
    if not isinstance(parsed, dict):
        return {'ok': False, 'error': 'unparseable decision JSON', 'raw': content[:200], 'latencyMs': ms}
    selected = parsed.get('selected')
    selected = selected if isinstance(selected, str) else (selected[0] if isinstance(selected, list) and selected else None)
    scores = parsed.get('scores') if isinstance(parsed.get('scores'), dict) else {}
    confidence = parsed.get('confidence') if isinstance(parsed.get('confidence'), (int, float)) else None
    usage = (body or {}).get('usage') or {}
    return {
        'ok': True, 'selected': selected, 'scores': scores, 'confidence': confidence,
        'latencyMs': ms, 'tokens': usage.get('total_tokens'), 'raw': content[:200],
    }


def ask_systemone(base_url, model, case, full_set, keep_alive, timeout):
    criteria = choices_for(case, full_set)
    body, ms, err = request(f"{base_url.rstrip('/')}/systemone", {
        'model': model,
        'state': f"{case['state']}\nEvidence: {case['evidence']}",
        'questions': {'next_action': {'type': 'choice', 'instructions': INSTRUCTIONS, 'criteria': criteria}},
        'keep_alive': keep_alive,
    }, timeout=timeout)
    if err:
        return {'ok': False, 'error': err, 'latencyMs': ms}
    answer = ((body or {}).get('answers') or {}).get('next_action') or {}
    probs = answer.get('probabilities') if isinstance(answer.get('probabilities'), dict) else {}
    confidence = answer.get('confidence')
    return {
        'ok': True, 'selected': answer.get('choice'), 'scores': probs, 'confidence': confidence,
        'latencyMs': ms, 'tokens': None, 'raw': json.dumps(answer)[:200],
    }


def is_correct(case, selected, offered):
    if selected is None:
        return False, 'no_selection'
    if selected == ABSTAIN_ID:
        return case['acceptAbstain'], 'abstain' if case['acceptAbstain'] else 'abstain_when_action_required'
    if selected == case['expected']:
        return True, 'correct'
    if selected not in offered:
        return False, 'invalid_choice'
    return False, 'wrong_action'


def run_model(spec, cases, args):
    # SPEC is `model` or `model@protocol`; model ids may contain colons.
    model, _, protocol = spec.partition('@')
    protocol = protocol or 'chat'
    if protocol not in ('chat', 'systemone'):
        raise SystemExit(f'unknown protocol in spec {spec!r}; expected chat or systemone')
    rows = []
    for index, case in enumerate(cases, 1):
        offered = choices_for(case, args.full_choice_set)
        ask = ask_systemone if protocol == 'systemone' else ask_chat
        result = ask(args.base_url, model, case, args.full_choice_set, args.keep_alive, args.timeout)
        offered_ids = list(offered)
        if not result['ok']:
            correct, kind = False, result.get('error', 'error')
        else:
            correct, kind = is_correct(case, result['selected'], offered_ids)
        row = {
            'model': model, 'protocol': protocol, 'case': case['id'], 'family': case['family'],
            'split': case['split'], 'subject': case['subject'], 'risk': case['risk'],
            'expected': case['expected'], 'predicted': result.get('selected'), 'kind': kind,
            'correct': correct, 'offered': offered_ids, 'latencyMs': result.get('latencyMs', 0),
            'confidence': result.get('confidence'), 'tokens': result.get('tokens'),
            'scores': {k: v for k, v in (result.get('scores') or {}).items() if isinstance(v, (int, float))},
            'error': result.get('error'),
        }
        rows.append(row)
        if args.verbose:
            print(f"  [{index}/{len(cases)}] {case['id']} {case['family']:<24} expected={case['expected']:<11} got={str(result.get('selected')):<11} {kind}")
    return rows


def summarize(rows, cases):
    n = len(rows)
    if not n:
        return {}
    correct = sum(1 for r in rows if r['correct'])
    abstains = [r for r in rows if r['predicted'] == ABSTAIN_ID]
    eligible_abstain = {c['id'] for c in cases if c['acceptAbstain']}
    escalations = [r for r in rows if r['predicted'] == 'escalate']
    latencies = [r['latencyMs'] for r in rows]
    confidences = [r['confidence'] for r in rows if isinstance(r['confidence'], (int, float))]
    buckets = {}
    for r in rows:
        if not isinstance(r['confidence'], (int, float)):
            continue
        bucket = min(4, int(r['confidence'] * 5))
        entry = buckets.setdefault(bucket, {'n': 0, 'correct': 0})
        entry['n'] += 1
        entry['correct'] += 1 if r['correct'] else 0
    return {
        'cases': n,
        'correct': correct,
        'accuracy': round(correct / n, 4),
        'accuracyCI95': wilson95(correct, n),
        'abstainRate': round(len(abstains) / n, 4),
        'correctAbstainRate': round(sum(1 for r in abstains if r['correct']) / len(abstains), 4) if abstains else None,
        'abstainOpportunities': len(eligible_abstain),
        'abstainOpportunitiesCovered': round(sum(1 for r in abstains if r['case'] in eligible_abstain) / len(eligible_abstain), 4) if eligible_abstain else None,
        'escalationRate': round(len(escalations) / n, 4),
        'highRiskAccuracy': round(sum(1 for r in rows if r['risk'] == 'high' and r['correct']) / max(1, sum(1 for r in rows if r['risk'] == 'high')), 4),
        'invalidResponseRate': round(sum(1 for r in rows if r['kind'] in ('invalid_choice', 'no_selection', 'unparseable decision JSON') or r['kind'].startswith('HTTP') or r['kind'].startswith('Err')) / n, 4),
        'meanLatencyMs': round(statistics.mean(latencies), 1) if latencies else 0,
        'p50LatencyMs': percentile(latencies, 50),
        'p95LatencyMs': percentile(latencies, 95),
        'meanConfidence': round(statistics.mean(confidences), 4) if confidences else None,
        'calibration': [
            {'bucket': f'{b / 5:.1f}-{(b + 1) / 5:.1f}', 'n': v['n'], 'accuracy': round(v['correct'] / v['n'], 4)}
            for b, v in sorted(buckets.items())
        ],
        'byFamily': {
            family: {
                'n': len(items),
                'accuracy': round(sum(1 for r in items if r['correct']) / len(items), 4),
            }
            for family, items in sorted(_group(rows, 'family').items())
        },
    }


def _group(rows, key):
    grouped = {}
    for row in rows:
        grouped.setdefault(row[key], []).append(row)
    return grouped


def format_markdown(model, summary, rows):
    lines = [f'# Decision routing benchmark — {model}', '',
             f"cases={summary['cases']} accuracy={summary['accuracy']:.1%} CI95={summary['accuracyCI95'][0]:.1%}-{summary['accuracyCI95'][1]:.1%}",
             f"abstain={summary['abstainRate']:.1%} (correct-abstain={summary['correctAbstainRate']}), escalation={summary['escalationRate']:.1%}, invalid={summary['invalidResponseRate']:.1%}",
             f"high-risk accuracy={summary['highRiskAccuracy']:.1%} · mean confidence={summary['meanConfidence']}",
             f"latency p50={summary['p50LatencyMs']}ms p95={summary['p95LatencyMs']}ms", '',
             '| family | n | accuracy |', '|---|---|---:|']
    for family, item in summary['byFamily'].items():
        lines.append(f"| {family} | {item['n']} | {item['accuracy']:.1%} |")
    lines += ['', '## Calibration (confidence vs correctness)', '', '| bucket | n | accuracy |', '|---|---|---:|']
    for bucket in summary['calibration']:
        lines.append(f"| {bucket['bucket']} | {bucket['n']} | {bucket['accuracy']:.1%} |")
    wrong = [r for r in rows if not r['correct']][:15]
    if wrong:
        lines += ['', '## Sample incorrect predictions', '',
                  '| case | family | expected | predicted | kind |', '|---|---|---|---|---|']
        lines += [f"| {r['case']} | {r['family']} | {r['expected']} | {r['predicted']} | {r['kind']} |" for r in wrong]
    return '\n'.join(lines) + '\n'


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--models', nargs='+', required=True,
                    help='model specs: MODEL or MODEL@protocol (chat|systemone); ids may contain colons')
    ap.add_argument('--base-url', default=DEFAULT_BASE)
    ap.add_argument('--split', choices=['all', 'train', 'holdout'], default='holdout',
                    help='corpus split to report on (default: holdout)')
    ap.add_argument('--limit', type=int, default=0, help='smoke-test subset size')
    ap.add_argument('--full-choice-set', action='store_true',
                    help='ablation: offer every action instead of the eligibility-filtered set')
    ap.add_argument('--no-evidence', action='store_true', help='ablation: omit the case evidence from the state')
    ap.add_argument('--keep-alive', default='30m')
    ap.add_argument('--timeout', type=int, default=180, help='per-request timeout in seconds')
    ap.add_argument('--seed', type=int, default=1, help='only used for --limit shuffling')
    ap.add_argument('--out', type=Path)
    ap.add_argument('--verbose', action='store_true')
    args = ap.parse_args()

    if not CORPUS.exists():
        print(f'corpus missing: {CORPUS} (run scripts/build-decision-corpus.py)', file=sys.stderr)
        return 2
    cases = [json.loads(line) for line in CORPUS.read_text(encoding='utf-8').splitlines() if line.strip()]
    if args.split != 'all':
        cases = [c for c in cases if c['split'] == args.split]
    if args.no_evidence:
        for case in cases:
            case['evidence'] = 'no evidence retrieved'
    if args.limit:
        random.Random(args.seed).shuffle(cases)
        cases = cases[:args.limit]
    if not cases:
        print(f'no cases for split={args.split}', file=sys.stderr)
        return 2
    print(f'corpus: {len(cases)} cases (split={args.split}, full_choice_set={args.full_choice_set})')

    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    RESULTS.mkdir(parents=True, exist_ok=True)
    report = {
        'generatedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
        'corpus': str(CORPUS.relative_to(Path(__file__).resolve().parents[1])),
        'split': args.split,
        'cases': len(cases),
        'eligibilityFiltering': not args.full_choice_set,
        'evidenceAugmented': not args.no_evidence,
        'models': {},
    }
    for spec in args.models:
        model = spec.partition(':')[0] if ':' in spec else spec
        print(f'\n== {spec} @ {args.base_url}')
        rows = run_model(spec, cases, args)
        summary = summarize(rows, cases)
        report['models'][spec] = summary
        print(f"   accuracy={summary['accuracy']:.1%} correct={summary['correct']}/{summary['cases']} "
              f"abstain={summary['abstainRate']:.1%} escalation={summary['escalationRate']:.1%} "
              f"invalid={summary['invalidResponseRate']:.1%} p50={summary['p50LatencyMs']}ms")
        stem = RESULTS / f'decision-bench-{stamp}-{re.sub(r"[^A-Za-z0-9_.-]+", "_", spec)}'
        stem.with_suffix('.jsonl').write_text('\n'.join(json.dumps(r, ensure_ascii=False) for r in rows) + '\n', encoding='utf-8')
        stem.with_suffix('.md').write_text(format_markdown(spec, summary, rows), encoding='utf-8')
        print(f'   predictions: {stem.with_suffix(".jsonl")}')
    report_path = args.out or (RESULTS / f'decision-bench-{stamp}.json')
    report_path.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(f'\nreport: {report_path}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
