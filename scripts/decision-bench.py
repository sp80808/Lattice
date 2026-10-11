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
  python3 scripts/decision-bench.py --models qwen3:1.7b tev1:0.8b@systemone
  python3 scripts/decision-bench.py --replay benchmarks/results/decision-bench-*.jsonl
"""
import argparse
import datetime as dt
import hashlib
import json
import math
import os
import random
import re
import statistics
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
        return None, round((time.perf_counter() - start) * 1000, 1), {
            'message': f'{err} {detail}'.strip(),
            'kind': 'invalid_response' if isinstance(err, ValueError) else 'request_error',
        }


def finite_number(value):
    return type(value) in (int, float) and math.isfinite(value)


def decision_result(selected, scores, confidence, ms, tokens=None, raw=''):
    if isinstance(selected, list) and len(selected) == 1:
        selected = selected[0]
    if (not isinstance(selected, str) or not selected or not isinstance(scores, dict)
            or any(not finite_number(v) or v < 0 for v in scores.values())
            or (confidence is not None and (not finite_number(confidence) or not 0 <= confidence <= 1))):
        return {'ok': False, 'error': 'invalid decision response', 'errorType': 'invalid_response',
                'latencyMs': ms, 'raw': raw[:200]}
    return {'ok': True, 'selected': selected, 'scores': scores, 'confidence': confidence,
            'latencyMs': ms, 'tokens': tokens, 'raw': raw[:200]}


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
        return {'ok': False, 'error': err['message'], 'errorType': err['kind'], 'latencyMs': ms}
    try:
        content = body['choices'][0]['message']['content']
        parsed = json.loads(content)
        return decision_result(parsed.get('selected'), parsed.get('scores'), parsed.get('confidence'),
                               ms, (body.get('usage') or {}).get('total_tokens'), content)
    except (KeyError, IndexError, TypeError, AttributeError, ValueError):
        return {'ok': False, 'error': 'unparseable decision JSON', 'errorType': 'invalid_response', 'latencyMs': ms}


def ask_systemone(base_url, model, case, full_set, keep_alive, timeout):
    criteria = choices_for(case, full_set)
    body, ms, err = request(f"{base_url.rstrip('/')}/systemone", {
        'model': model,
        'state': f"{case['state']}\nEvidence: {case['evidence']}",
        'questions': {'next_action': {'type': 'choice', 'instructions': INSTRUCTIONS, 'criteria': criteria}},
        'keep_alive': keep_alive,
    }, timeout=timeout)
    if err:
        return {'ok': False, 'error': err['message'], 'errorType': err['kind'], 'latencyMs': ms}
    try:
        answer = body['answers']['next_action']
        return decision_result(answer.get('choice'), answer.get('probabilities'), answer.get('confidence'),
                               ms, raw=json.dumps(answer))
    except (KeyError, TypeError, AttributeError):
        return {'ok': False, 'error': 'invalid SystemOne response', 'errorType': 'invalid_response', 'latencyMs': ms}


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


def run_model(spec, cases, args, output=None):
    # SPEC is `model` or `model@protocol`; model ids may contain colons.
    model, _, protocol = spec.partition('@')
    protocol = protocol or 'chat'
    if protocol not in ('chat', 'systemone'):
        raise SystemExit(f'unknown protocol in spec {spec!r}; expected chat or systemone')
    rows = []
    consecutive_errors = 0
    for index, case in enumerate(cases, 1):
        offered = choices_for(case, args.full_choice_set)
        ask = ask_systemone if protocol == 'systemone' else ask_chat
        result = ask(args.base_url, model, case, args.full_choice_set, args.keep_alive, args.timeout)
        offered_ids = list(offered)
        if not result['ok']:
            correct, kind = False, result['errorType']
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
            'errorType': result.get('errorType'),
        }
        rows.append(row)
        if output is not None:
            output.write(json.dumps(row, ensure_ascii=False, allow_nan=False) + '\n')
            output.flush()
            os.fsync(output.fileno())
        if args.verbose:
            print(f"  [{index}/{len(cases)}] {case['id']} {case['family']:<24} expected={case['expected']:<11} got={str(result.get('selected')):<11} {kind}")
        consecutive_errors = consecutive_errors + 1 if kind == 'request_error' else 0
        if consecutive_errors >= 3:
            print(f'  stopped after 3 consecutive request errors: {result["error"]}', file=sys.stderr)
            break
    return rows


def failure_kind(row):
    if row.get('errorType'):
        return row['errorType']
    if row['kind'] in ('invalid_choice', 'no_selection', 'unparseable decision JSON', 'invalid_response'):
        return 'invalid_response'
    if row.get('error') or row['kind'] == 'request_error':
        return 'request_error'
    return 'decision'


def summarize(rows, cases):
    n = len(rows)
    if not n:
        return {}
    correct = sum(1 for r in rows if r['correct'])
    request_errors = sum(failure_kind(r) == 'request_error' for r in rows)
    invalid = sum(failure_kind(r) == 'invalid_response' for r in rows)
    valid = [r for r in rows if failure_kind(r) == 'decision']
    abstains = [r for r in rows if r['predicted'] == ABSTAIN_ID]
    eligible_abstain = {c['id'] for c in cases if c['acceptAbstain']}
    escalations = [r for r in rows if r['predicted'] == 'escalate']
    latencies = [r['latencyMs'] for r in rows]
    confidences = [r['confidence'] for r in valid if finite_number(r['confidence']) and 0 <= r['confidence'] <= 1]
    buckets = {}
    for r in valid:
        if not finite_number(r['confidence']) or not 0 <= r['confidence'] <= 1:
            continue
        bucket = min(4, int(r['confidence'] * 5))
        entry = buckets.setdefault(bucket, {'n': 0, 'correct': 0})
        entry['n'] += 1
        entry['correct'] += 1 if r['correct'] else 0
    return {
        'cases': n,
        'plannedCases': len(cases),
        'unattemptedCases': max(0, len(cases) - n),
        'status': 'incomplete' if n != len(cases) else ('failed' if request_errors or invalid else 'complete'),
        'correct': correct,
        'accuracy': round(correct / n, 4),
        'accuracyCI95': wilson95(correct, n),
        'abstainRate': round(len(abstains) / n, 4),
        'correctAbstainRate': round(sum(1 for r in abstains if r['correct']) / len(abstains), 4) if abstains else None,
        'abstainOpportunities': len(eligible_abstain),
        'abstainOpportunitiesCovered': round(sum(1 for r in abstains if r['case'] in eligible_abstain) / len(eligible_abstain), 4) if eligible_abstain else None,
        'escalationRate': round(len(escalations) / n, 4),
        'highRiskAccuracy': round(sum(1 for r in rows if r['risk'] == 'high' and r['correct']) / max(1, sum(1 for r in rows if r['risk'] == 'high')), 4),
        'requestErrors': request_errors,
        'requestErrorRate': round(request_errors / n, 4),
        'invalidResponses': invalid,
        'invalidResponseRate': round(invalid / n, 4),
        'validResponses': len(valid),
        'responseAccuracy': round(sum(r['correct'] for r in valid) / len(valid), 4) if valid else None,
        'responseAccuracyCI95': wilson95(sum(r['correct'] for r in valid), len(valid)) if valid else None,
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
                'requestErrors': sum(failure_kind(r) == 'request_error' for r in items),
                'invalidResponses': sum(failure_kind(r) == 'invalid_response' for r in items),
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
             f"status={summary['status']} attempted={summary['cases']} planned={summary['plannedCases']}",
             f"cases={summary['cases']} accuracy={summary['accuracy']:.1%} CI95={summary['accuracyCI95'][0]:.1%}-{summary['accuracyCI95'][1]:.1%}",
             f"abstain={summary['abstainRate']:.1%} (correct-abstain={summary['correctAbstainRate']}), escalation={summary['escalationRate']:.1%}, invalid={summary['invalidResponseRate']:.1%}",
             f"high-risk accuracy={summary['highRiskAccuracy']:.1%} · mean confidence={summary['meanConfidence']}",
             f"latency p50={summary['p50LatencyMs']}ms p95={summary['p95LatencyMs']}ms", '',
             f"request errors={summary['requestErrors']} ({summary['requestErrorRate']:.1%}); invalid model responses={summary['invalidResponses']}",
             f"accuracy on {summary['validResponses']} valid responses=" + (f"{summary['responseAccuracy']:.1%}" if summary['responseAccuracy'] is not None else 'unavailable') + ' (excludes failures; not a promotion score)',
             summary.get('originalRunProvenance', ''), '',
             '| family | n | accuracy | request errors | invalid responses |', '|---|---|---:|---:|---:|']
    for family, item in summary['byFamily'].items():
        lines.append(f"| {family} | {item['n']} | {item['accuracy']:.1%} | {item['requestErrors']} | {item['invalidResponses']} |")
    lines += ['', '## Calibration (confidence vs correctness)', '', '| bucket | n | accuracy |', '|---|---|---:|']
    for bucket in summary['calibration']:
        lines.append(f"| {bucket['bucket']} | {bucket['n']} | {bucket['accuracy']:.1%} |")
    wrong = [r for r in rows if not r['correct']][:15]
    if wrong:
        lines += ['', '## Sample incorrect predictions', '',
                  '| case | family | expected | predicted | kind |', '|---|---|---|---|---|']
        lines += [f"| {r['case']} | {r['family']} | {r['expected']} | {r['predicted']} | {r['kind']} |" for r in wrong]
    return '\n'.join(lines) + '\n'


def artifact_path(stamp, spec, suffix):
    slug = re.sub(r'[^A-Za-z0-9_.-]+', '_', spec)
    digest = hashlib.sha256(spec.encode()).hexdigest()[:8]
    return RESULTS / f'decision-bench-{stamp}-{slug}-{digest}{suffix}'


def replay_rows(path, cases):
    rows = [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]
    known = {c['id']: c for c in cases}
    seen = set()
    models = {(r['model'], r['protocol']) for r in rows}
    if len(models) != 1:
        raise ValueError(f'{path}: expected one nonempty model/protocol run')
    for row in rows:
        case = known.get(row['case'])
        if case is None or row['case'] in seen:
            raise ValueError(f'{path}: unknown or duplicate case {row["case"]}')
        seen.add(row['case'])
        if any(row[key] != case[key] for key in ('expected', 'family', 'split', 'risk')):
            raise ValueError(f'{path}: case metadata differs from corpus for {row["case"]}')
        if row.get('error'):
            row['correct'] = False
        else:
            row['correct'], row['kind'] = is_correct(case, row['predicted'], row['offered'])
    return rows, [known[r['case']] for r in rows]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    source = ap.add_mutually_exclusive_group(required=True)
    source.add_argument('--models', nargs='+',
                    help='model specs: MODEL or MODEL@protocol (chat|systemone); ids may contain colons')
    source.add_argument('--replay', nargs='+', type=Path, help='reanalyse saved prediction JSONL without model requests')
    ap.add_argument('--corpus', type=Path, default=CORPUS)
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

    if not args.corpus.exists():
        print(f'corpus missing: {args.corpus} (run scripts/build-decision-corpus.py)', file=sys.stderr)
        return 2
    corpus_bytes = args.corpus.read_bytes()
    cases = [json.loads(line) for line in corpus_bytes.decode('utf-8').splitlines() if line.strip()]
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

    if args.replay and (args.no_evidence or args.full_choice_set or args.limit):
        ap.error('replay cannot change evidence, choices, or case limits')
    if args.models and (len(set(args.models)) != len(args.models) or any(
            not spec.partition('@')[0] or spec.partition('@')[2] not in ('', 'chat', 'systemone') for spec in args.models)):
        ap.error('model specs must be unique and use chat or systemone')
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    RESULTS.mkdir(parents=True, exist_ok=True)
    report = {
        'schemaVersion': 2,
        'status': 'running',
        'generatedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
        'corpus': str(args.corpus.resolve()),
        'corpusSha256': hashlib.sha256(corpus_bytes).hexdigest(),
        'caseIds': [c['id'] for c in cases],
        'seed': args.seed,
        'requestedModels': args.models or [],
        'harnessSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'evaluationCasesSha256': hashlib.sha256(json.dumps(cases, sort_keys=True).encode()).hexdigest(),
        'timeoutSeconds': args.timeout,
        'split': args.split,
        'cases': len(cases),
        'eligibilityFiltering': None if args.replay else not args.full_choice_set,
        'evidenceAugmented': None if args.replay else not args.no_evidence,
        'baseUrl': None if args.replay else args.base_url,
        'replayed': bool(args.replay),
        'models': {},
    }
    report_path = args.out or (RESULTS / f'decision-bench-{stamp}.json')
    # Reserve before requests, and leave a manifest if the process is interrupted.
    with report_path.open('x', encoding='utf-8') as handle:
        handle.write(json.dumps(report, indent=2) + '\n')
    for item in args.replay or args.models:
        if args.replay:
            rows, measured_cases = replay_rows(item, cases)
            spec = f'{rows[0]["model"]}@{rows[0]["protocol"]}'
            key = f'{spec} [{item.name}]'
            summary = summarize(rows, measured_cases)
            summary.update({'source': str(item.resolve()),
                            'sourceSha256': hashlib.sha256(item.read_bytes()).hexdigest(),
                            'originalRunProvenance': 'not recorded; corpus match checks labels, not original prompts',
                            'plannedCases': None, 'unattemptedCases': None})
            if summary['status'] == 'complete':
                summary['status'] = 'replayed'
        else:
            spec = key = item
            print(f'\n== {spec} @ {args.base_url}')
            path = artifact_path(stamp, key, '.jsonl')
            with path.open('x', encoding='utf-8') as handle:
                rows = run_model(spec, cases, args, handle)
            summary = summarize(rows, cases)
            summary['predictions'] = str(path)
        report['models'][key] = summary
        print(f"   accuracy={summary['accuracy']:.1%} correct={summary['correct']}/{summary['cases']} "
              f"abstain={summary['abstainRate']:.1%} escalation={summary['escalationRate']:.1%} "
              f"request errors={summary['requestErrorRate']:.1%} invalid={summary['invalidResponseRate']:.1%} p50={summary['p50LatencyMs']}ms")
        with artifact_path(stamp, key, '.md').open('x', encoding='utf-8') as handle:
            handle.write(format_markdown(key, summary, rows))
        report_path.write_text(json.dumps(report, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    report['status'] = 'replayed' if args.replay else ('failed' if any(s['status'] != 'complete' for s in report['models'].values()) else 'complete')
    report_path.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(f'\nreport: {report_path}')
    return 1 if report['status'] == 'failed' else 0


if __name__ == '__main__':
    sys.exit(main())
