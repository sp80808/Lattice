"""Offline regression checks for benchmark accounting and artifact integrity."""
import ast
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError

SCRIPT = Path(__file__).with_name('decision-bench.py')
spec = importlib.util.spec_from_file_location('decision_bench', SCRIPT)
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)
CASE = {'id': 'c1', 'expected': 'inspect', 'acceptAbstain': False, 'allow': ['inspect', 'edit'],
        'state': 'No source inspected', 'evidence': 'No evidence yet', 'family': 'evidence-missing',
        'split': 'holdout', 'subject': 'parser', 'risk': 'low'}
ARGS = SimpleNamespace(full_choice_set=False, base_url='http://localhost/v1', keep_alive='0', timeout=1, verbose=False)


def row(source_case=CASE, **changes):
    value = {'model': 'test:1.7b', 'protocol': 'chat', 'case': source_case['id'], 'family': source_case['family'],
             'split': source_case['split'], 'risk': source_case['risk'], 'expected': source_case['expected'],
             'predicted': 'inspect', 'correct': True, 'kind': 'correct', 'offered': source_case['allow'],
             'confidence': 0.8, 'latencyMs': 5, 'error': None}
    value.update(changes)
    return value


class DecisionBenchTests(unittest.TestCase):
    def test_scoring_rejects_gold_or_abstain_if_not_offered(self):
        self.assertEqual(bench.is_correct(CASE, 'inspect', ['edit']), (False, 'invalid_choice'))
        self.assertEqual(bench.is_correct({**CASE, 'acceptAbstain': True}, 'abstain', ['edit']),
                         (False, 'invalid_choice'))
        self.assertEqual(bench.is_correct({**CASE, 'acceptAbstain': True}, 'abstain', ['abstain']),
                         (True, 'abstain'))

    def test_colab_scoring_matches_local_without_loading_training_dependencies(self):
        local = next(n for n in ast.parse(SCRIPT.read_text()).body if isinstance(n, ast.FunctionDef) and n.name == 'is_correct')
        for name in ('colab_zero_shot.py', 'colab_teacher_label.py', 'colab_train_router_v2.py'):
            tree = ast.parse(SCRIPT.with_name(name).read_text())
            fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'is_correct')
            self.assertEqual(ast.dump(fn), ast.dump(local), name)

    def test_model_paths_preserve_decimals_protocol_and_sanitized_collisions(self):
        specs = ['qwen3:1.7b@chat', 'qwen3:1.7b@systemone', 'qwen3/1.7b@chat']
        paths = [bench.artifact_path('stamp', s, '.jsonl') for s in specs]
        self.assertEqual(len(set(paths)), 3)
        self.assertTrue(all(p.suffix == '.jsonl' and '1.7b' in p.name for p in paths))

    def test_response_validates_one_choice_and_finite_numbers(self):
        self.assertTrue(bench.decision_result(['inspect'], {'inspect': 1}, 0, 1)['ok'])
        for selected, scores, confidence in [(['inspect', 'edit'], {}, 0.8),
                ('inspect', [], 0.8), ('inspect', {'inspect': -1}, 0.8),
                ('inspect', {'inspect': True}, 0.8), ('inspect', {'inspect': float('nan')}, 0.8),
                ('inspect', {}, float('inf')), ('inspect', {}, True), ('inspect', {}, 1.1)]:
            with self.subTest(selected=selected, scores=scores, confidence=confidence):
                result = bench.decision_result(selected, scores, confidence, 1)
                self.assertFalse(result['ok'])
                self.assertEqual(result['errorType'], 'invalid_response')

    def test_malformed_provider_envelopes_are_invalid_responses(self):
        for body in (None, [], {}, {'choices': []}, {'choices': [{'message': {'content': '[]'}}]}):
            with patch.object(bench, 'request', return_value=(body, 1, None)):
                self.assertEqual(bench.ask_chat('url', 'model', CASE, False, '0', 1)['errorType'], 'invalid_response')
                self.assertEqual(bench.ask_systemone('url', 'model', CASE, False, '0', 1)['errorType'], 'invalid_response')

    def test_http_and_connection_failures_are_request_errors(self):
        for error in (URLError('Connection refused'), HTTPError('http://localhost', 500, 'Metal failed', {}, io.BytesIO(b'runner unavailable'))):
            with patch.object(bench, 'urlopen', side_effect=error):
                self.assertEqual(bench.request('http://localhost')[2]['kind'], 'request_error')

    def test_invalid_http_json_is_an_invalid_response(self):
        response = io.BytesIO(b'not JSON')
        with patch.object(bench, 'urlopen', return_value=response):
            self.assertEqual(bench.request('http://localhost')[2]['kind'], 'invalid_response')

    def test_summary_separates_legacy_outages_invalid_output_and_wrong_actions(self):
        rows = [row(), row(correct=False, predicted='edit', kind='wrong_action'),
                row(correct=False, predicted=None, kind='<urlopen error [Errno 61] Connection refused>', error='connection refused'),
                row(correct=False, predicted=None, kind='unparseable decision JSON', error='unparseable decision JSON')]
        summary = bench.summarize(rows, [CASE] * 4)
        self.assertEqual(summary['accuracy'], 0.25)
        self.assertEqual(summary['responseAccuracy'], 0.5)
        self.assertEqual(summary['requestErrorRate'], 0.25)
        self.assertEqual(summary['invalidResponseRate'], 0.25)
        self.assertEqual(summary['validResponses'], 2)
        self.assertEqual(sum(b['n'] for b in summary['calibration']), 2)
        self.assertEqual(summary['status'], 'failed')

    def test_zero_valid_responses_has_no_conditional_accuracy(self):
        summary = bench.summarize([row(correct=False, kind='request_error', predicted=None, error='offline')], [CASE])
        self.assertIsNone(summary['responseAccuracy'])
        self.assertIsNone(summary['responseAccuracyCI95'])

    def test_invalid_confidence_is_excluded_from_calibration(self):
        rows = [row(confidence=c) for c in (True, float('nan'), -1, 2)]
        summary = bench.summarize(rows, [CASE] * 4)
        self.assertIsNone(summary['meanConfidence'])
        self.assertEqual(summary['calibration'], [])

    def test_outage_stops_after_three_and_saves_every_attempt(self):
        cases = [{**CASE, 'id': f'c{i}'} for i in range(5)]
        error = {'ok': False, 'error': 'offline', 'errorType': 'request_error', 'latencyMs': 1}
        with tempfile.TemporaryDirectory() as directory, patch.object(bench, 'ask_chat', return_value=error) as ask:
            path = Path(directory) / 'predictions.jsonl'
            with path.open('x') as handle, contextlib.redirect_stderr(io.StringIO()):
                rows = bench.run_model('test@chat', cases, ARGS, handle)
            self.assertEqual(ask.call_count, 3)
            self.assertEqual(len(path.read_text().splitlines()), 3)
            summary = bench.summarize(rows, cases)
            self.assertEqual(summary['unattemptedCases'], 2)
            self.assertEqual(summary['status'], 'incomplete')

    def test_saved_prediction_survives_interruption(self):
        result = bench.decision_result('inspect', {'inspect': 1}, 1, 1)
        with tempfile.TemporaryDirectory() as directory, patch.object(bench, 'ask_chat', side_effect=[result, KeyboardInterrupt]):
            path = Path(directory) / 'predictions.jsonl'
            with path.open('x') as handle, self.assertRaises(KeyboardInterrupt):
                bench.run_model('test@chat', [CASE, {**CASE, 'id': 'c2'}], ARGS, handle)
            self.assertEqual(json.loads(path.read_text())['case'], CASE['id'])

    def test_replay_recomputes_scores_and_rejects_duplicate_or_mismatched_cases(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'source.jsonl'
            path.write_text(json.dumps(row(correct=False, kind='wrong_action')) + '\n')
            rows, _ = bench.replay_rows(path, [CASE])
            self.assertTrue(rows[0]['correct'])
            for bad_rows in ([row(), row()], [row(expected='edit')], [row(case='unknown')]):
                path.write_text(''.join(json.dumps(r) + '\n' for r in bad_rows))
                with self.assertRaises(ValueError):
                    bench.replay_rows(path, [CASE])

    def test_cli_replay_is_offline_hashes_sources_and_preserves_originals(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(bench, 'RESULTS', Path(directory)), patch.object(bench, 'request', side_effect=AssertionError('must stay offline')):
            corpus = Path(directory) / 'corpus.jsonl'
            corpus.write_text(json.dumps(CASE) + '\n')
            source = Path(directory) / 'source.jsonl'
            original = json.dumps(row()) + '\n'
            source.write_text(original)
            report = Path(directory) / 'report.json'
            argv = ['decision-bench', '--corpus', str(corpus), '--replay', str(source), '--out', str(report)]
            with patch.object(sys, 'argv', argv), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(bench.main(), 0)
            data = json.loads(report.read_text())
            self.assertEqual(data['status'], 'replayed')
            self.assertEqual(len(data['corpusSha256']), 64)
            self.assertIsNone(next(iter(data['models'].values()))['plannedCases'])
            self.assertEqual(source.read_text(), original)
            with patch.object(sys, 'argv', argv), contextlib.redirect_stdout(io.StringIO()), self.assertRaises(FileExistsError):
                bench.main()

    def test_cli_failed_run_exits_nonzero_and_keeps_manifest(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(bench, 'RESULTS', Path(directory)):
            corpus = Path(directory) / 'corpus.jsonl'
            corpus.write_text(''.join(json.dumps({**CASE, 'id': f'c{i}'}) + '\n' for i in range(5)))
            report = Path(directory) / 'report.json'
            argv = ['decision-bench', '--corpus', str(corpus), '--models', 'test:1.7b@chat', '--out', str(report)]
            error = {'ok': False, 'error': 'offline', 'errorType': 'request_error', 'latencyMs': 1}
            with patch.object(sys, 'argv', argv), patch.object(bench, 'ask_chat', return_value=error), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(bench.main(), 1)
            data = json.loads(report.read_text())
            self.assertEqual(data['requestedModels'], ['test:1.7b@chat'])
            self.assertEqual(data['models']['test:1.7b@chat']['unattemptedCases'], 2)


if __name__ == '__main__':
    unittest.main()
