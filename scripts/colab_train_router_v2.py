#!/usr/bin/env python3
"""Lattice Decision Router Fine-Tuning v2 (Colab Tesla T4 GPU).

Trains a LoRA router on the real decision corpus (benchmarks/decisions/corpus.jsonl,
train split only) and evaluates on the 110-case holdout split using the exact
chat contract from scripts/decision-bench.py, so results are directly comparable
to the tev1:0.8b@systemone (87.3%) and qwen3:1.7b@chat (37-57%) baselines.

Supports multiple base models in one session so the base is chosen by measured
holdout accuracy, not by release notes. Bases tested:
  Qwen/Qwen3-4B-Instruct-2507   text-only dense 4B, #1 post-fine-tuning in the
                                distil-labs Aug-2026 12-SLM study
  Qwen/Qwen3.5-4B               current-gen Mar-2026 4B, native tool calling,
                                multimodal snapshot (vision tower ignored here),
                                thinking disabled via chat_template_kwargs

Improvements over v1:
  - real corpus instead of 16 hand-written frames (130 train cases)
  - completion-only loss masking (v1 trained on the prompt too)
  - eligibility-filtered + full-choice-set + deterministic order-shuffle augmentation
  - zero-shot baseline measured on the same 110-case holdout, per base

Usage on Colab:  python3 colab_train_router_v2.py --bases Qwen/Qwen3-4B-Instruct-2507 Qwen/Qwen3.5-4B
"""
import argparse
import datetime as dt
import json
import random
import re
import statistics
import subprocess
import sys
import time
import traceback
from pathlib import Path

try:
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from peft import LoraConfig, get_peft_model
except ImportError:
    subprocess.run([sys.executable, '-m', 'pip', 'install', '-q', '-U', 'transformers', 'peft', 'accelerate'], check=True)
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from peft import LoraConfig, get_peft_model

# --- persistence: manifest at start, per-milestone flush, --resume idempotence
sys.path.insert(0, str(Path(__file__).resolve().parent))  # local: Lattice/scripts/
if Path("/content/colab_persist.py").exists():             # remote: uploaded helper
    sys.path.insert(0, "/content")
try:
    from lib.colab_persist import ColabRun
except ImportError:
    from colab_persist import ColabRun

CORPUS = Path('/content/corpus.jsonl')
OUTPUT_ROOT = Path('/content/lattice-router-v2')

# --- contract copied verbatim from scripts/decision-bench.py (do not drift) ---
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
SYSTEM_LINES = [
    'You are Lattice\'s bounded decision engine.',
    'Use only the supplied state, question and choices.',
    'Do not invent repository facts.',
    f'Return JSON only matching this contract: {json.dumps(CONTRACT)}.',
    'Valid choice IDs: {ids}.',
    f'If evidence is insufficient, select {ABSTAIN_ID} when it is offered.',
]
TEMPLATE_KWARGS = {'enable_thinking': False}


def system_for(ids):
    # same construction as decision-bench.py: interpolate ids into the line, never .format() the whole block
    lines = list(SYSTEM_LINES)
    lines[4] = f'Valid choice IDs: {", ".join(ids)}.'
    return '\n'.join(lines)


def choices_for(case, full_set):
    ids = list(case['allow']) if not full_set else ['inspect', 'edit', 'run_tests', 'finish', 'escalate', 'none']
    if case['acceptAbstain'] and ABSTAIN_ID not in ids:
        ids.append(ABSTAIN_ID)
    return {id: SUMMARY[id] for id in ids}


def build_prompt(case, full_set, order=None):
    """Byte-identical to decision-bench.ask_chat prompt construction."""
    criteria = choices_for(case, full_set)
    ids = list(criteria)
    if order == 'shuffled':
        seed = sum((i + 1) * ord(c) for i, c in enumerate(case['id']))
        ids = random.Random(seed).sample(ids, len(ids))
    system = system_for(ids)
    user = json.dumps({
        'mode': 'choice',
        'state': f"{case['state']}\nEvidence: {case['evidence']}",
        'question': INSTRUCTIONS,
        'choices': [{'id': id, 'summary': SUMMARY[id]} for id in ids],
    }, ensure_ascii=False)
    return system, user, ids


def chat(system, user, assistant=None):
    msgs = [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}]
    if assistant is not None:
        msgs.append({'role': 'assistant', 'content': assistant})
    return msgs


def target_json(expected, offered_ids):
    scores = {i: (1.0 if i == expected else 0.0) for i in offered_ids}
    return json.dumps({'selected': expected, 'scores': scores,
                       'confidence': 0.6 if expected == ABSTAIN_ID else 0.9})


# ----------------------------- training data -------------------------------

def build_train_examples(train_cases):
    examples = []
    for case in train_cases:
        expected = case['expected']
        for full_set, order in [(False, None), (False, 'shuffled'), (True, 'shuffled')]:
            system, user, ids = build_prompt(case, full_set, order)
            if expected not in ids:
                continue
            examples.append({
                'system': system, 'user': user,
                'target': target_json(expected, ids),
                'case': case['id'], 'variant': f'full={int(full_set)},order={order}',
            })
    return examples


def encode_example(tok, ex, max_len):
    prompt = tok.apply_chat_template(chat(ex['system'], ex['user']), tokenize=False,
                                     add_generation_prompt=True, chat_template_kwargs=TEMPLATE_KWARGS)
    full = tok.apply_chat_template(chat(ex['system'], ex['user'], ex['target']), tokenize=False,
                                   chat_template_kwargs=TEMPLATE_KWARGS)
    prompt_ids = tok(prompt, add_special_tokens=False)['input_ids']
    full_ids = tok(full, add_special_tokens=False)['input_ids'][:max_len]
    labels = [-100] * len(prompt_ids) + full_ids[len(prompt_ids):]
    return full_ids, labels[:max_len]


def collate(batch, pad_id):
    maxlen = max(len(x[0]) for x in batch)
    input_ids, labels, attn = [], [], []
    for ids, lab in batch:
        pad = maxlen - len(ids)
        input_ids.append(ids + [pad_id] * pad)
        labels.append(lab + [-100] * pad)
        attn.append([1] * len(ids) + [0] * pad)
    return (torch.tensor(input_ids), torch.tensor(attn), torch.tensor(labels))


# --------------------------------- eval -------------------------------------

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


def percentile(values, pct):
    if not values:
        return None
    values = sorted(values)
    index = min(len(values) - 1, max(0, int(round((pct / 100) * (len(values) - 1)))))
    return round(values[index], 1)


def evaluate(model, tok, cases, verbose=False):
    import torch

    model.eval()
    rows = []
    with torch.inference_mode():
        for index, case in enumerate(cases, 1):
            system, user, ids = build_prompt(case, False)
            prompt = tok.apply_chat_template(chat(system, user), tokenize=False,
                                             add_generation_prompt=True, chat_template_kwargs=TEMPLATE_KWARGS)
            inputs = tok(prompt, return_tensors='pt').to(model.device)
            start = time.perf_counter()
            out = model.generate(**inputs, max_new_tokens=96, do_sample=False)
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
            if verbose:
                print(f"  [{index}/{len(cases)}] {case['id']} {case['family']:<26} "
                      f"exp={case['expected']:<11} got={str(selected):<11} {kind}", flush=True)
    return rows


def summarize(rows):
    n = len(rows)
    if not n:
        return {}
    correct = sum(1 for r in rows if r['correct'])
    families = {}
    for r in rows:
        families.setdefault(r['family'], []).append(r)
    buckets = {}
    for r in rows:
        if not isinstance(r.get('confidence'), (int, float)):
            continue
        key = ['0.0-0.2', '0.2-0.4', '0.4-0.6', '0.6-0.8', '0.8-1.0'][min(4, int(min(1.0, max(0.0, r['confidence'])) * 5))]
        buckets.setdefault(key, []).append(r)
    latencies = [r['latencyMs'] for r in rows if isinstance(r.get('latencyMs'), (int, float))]
    return {
        'cases': n,
        'correct': correct,
        'accuracy': round(correct / n, 4),
        'abstainRate': round(sum(1 for r in rows if r['predicted'] == ABSTAIN_ID) / n, 4),
        'highRiskAccuracy': round(sum(1 for r in rows if r['risk'] == 'high' and r['correct']) /
                                  max(1, sum(1 for r in rows if r['risk'] == 'high')), 4),
        'invalidRate': round(sum(1 for r in rows if r['kind'] in ('invalid_choice', 'no_selection')) / n, 4),
        'byFamily': {f: {'n': len(v), 'accuracy': round(sum(1 for r in v if r['correct']) / len(v), 4)}
                     for f, v in sorted(families.items())},
        'calibration': {k: {'n': len(v), 'accuracy': round(sum(1 for r in v if r['correct']) / len(v), 4)}
                        for k, v in sorted(buckets.items())},
        'latencyMs': {'p50': percentile(latencies, 50), 'p95': percentile(latencies, 95),
                      'mean': round(statistics.mean(latencies), 1) if latencies else None},
    }


# --------------------------------- runs --------------------------------------

def load_dtype(torch):
    """T4 (sm_75) cannot do bfloat16; fp16 there, bf16 on Ampere+."""
    if not torch.cuda.is_available():
        return torch.float32
    return torch.bfloat16 if torch.cuda.get_device_capability()[0] >= 8 else torch.float16


def from_pretrained(cls, base):
    try:
        return cls.from_pretrained(base, dtype=load_dtype(torch), device_map='auto')
    except TypeError:
        return cls.from_pretrained(base, torch_dtype=load_dtype(torch), device_map='auto')


def load_base(base):
    tok = AutoTokenizer.from_pretrained(base)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    model = None
    for cls in ('causal', 'image_text'):
        try:
            if cls == 'causal':
                model = from_pretrained(AutoModelForCausalLM, base)
            else:
                from transformers import AutoModelForImageTextToText
                model = from_pretrained(AutoModelForImageTextToText, base)
            break
        except Exception as err:
            print(f'  load via {cls} failed: {type(err).__name__}: {str(err)[:200]}', flush=True)
    if model is None:
        raise RuntimeError(f'could not load {base}')
    model.config.use_cache = False
    return tok, model


def run_base(base, args, train_cases, holdout, examples, encoded, run):
    print(f'\n================ BASE: {base} ================', flush=True)
    tok, model = load_base(base)
    device = str(next(model.parameters()).device)
    vram = round(torch.cuda.get_device_properties(0).total_memory / 1024 ** 3, 2) if torch.cuda.is_available() else 0
    print(f'device={device} vram={vram}GiB params={sum(p.numel() for p in model.parameters()) / 1e9:.2f}B', flush=True)

    base_rows = evaluate(model, tok, holdout)
    base_summary = summarize(base_rows)
    print(f'zero-shot holdout accuracy: {base_summary["accuracy"]:.1%} '
          f'(invalid={base_summary["invalidRate"]:.1%})', flush=True)
    run.emit(f'zero-shot-{base.replace("/", "__")}.json', base_summary)

    model = get_peft_model(model, LoraConfig(
        r=args.lora_r, lora_alpha=args.lora_alpha, lora_dropout=0.05,
        target_modules='all-linear', task_type='CAUSAL_LM'))
    model.print_trainable_parameters()
    try:
        model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={'use_reentrant': False})
    except TypeError:
        model.gradient_checkpointing_enable()

    optimizer = torch.optim.AdamW((p for p in model.parameters() if p.requires_grad), lr=args.lr, weight_decay=0.01)
    steps_per_epoch = (len(encoded) + args.batch - 1) // args.batch
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=max(1, args.epochs * steps_per_epoch))

    model.train()
    start = time.perf_counter()
    loss_history = []
    rng = random.Random(args.seed)
    step = 0
    for epoch in range(args.epochs):
        order = list(range(len(encoded)))
        rng.shuffle(order)
        epoch_loss, nb = 0.0, 0
        for i in range(0, len(order), args.batch):
            batch = collate([encoded[j] for j in order[i:i + args.batch]], tok.pad_token_id)
            input_ids, attn, labels = [t.to(device) for t in batch]
            loss = model(input_ids=input_ids, attention_mask=attn, labels=labels).loss
            loss.backward()
            epoch_loss += loss.item()
            nb += 1
            step += 1
            if step % 2 == 0:
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                optimizer.step()
                scheduler.step()
                optimizer.zero_grad()
        if step % 2 != 0:
            optimizer.step()
            scheduler.step()
            optimizer.zero_grad()
        avg = round(epoch_loss / max(1, nb), 4)
        loss_history.append(avg)
        print(f'  epoch {epoch + 1}/{args.epochs} loss={avg}', flush=True)
        # per-epoch adapter save: a killed training run still yields the
        # latest checkpoint, and resume continues from it
        out_dir = run.dir / f'adapter-{base.replace("/", "__")}-epoch{epoch + 1}'
        out_dir.mkdir(parents=True, exist_ok=True)
        model.save_pretrained(out_dir)
        tok.save_pretrained(out_dir)
        run.emit(f'adapter-{base.replace("/", "__")}-epoch{epoch + 1}.json', {
            'epoch': epoch + 1, 'loss': avg, 'adapterDir': str(out_dir),
        }, kind='adapter', stream=False)
    train_time = round(time.perf_counter() - start, 1)

    post_rows = evaluate(model, tok, holdout)
    post_summary = summarize(post_rows)

    out_dir = run.dir / f'adapter-{base.replace("/", "__")}-final'
    out_dir.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(out_dir)
    tok.save_pretrained(out_dir)

    metrics = {
        'model': base,
        'method': 'LoRA all-linear, completion-masked loss, corpus train split + augmentation, grad-ckpt',
        'trainSamples': len(train_cases),
        'trainExamples': len(examples),
        'testSamples': len(holdout),
        'epochs': args.epochs, 'lr': args.lr, 'batchSize': args.batch,
        'loraR': args.lora_r, 'loraAlpha': args.lora_alpha, 'seed': args.seed,
        'baseZeroShot': base_summary, 'postFineTune': post_summary,
        'gain': round(post_summary['accuracy'] - base_summary['accuracy'], 4),
        'initialLoss': loss_history[0] if loss_history else None,
        'finalLoss': loss_history[-1] if loss_history else None,
        'trainTimeSec': train_time, 'device': device, 'vramGiB': vram,
        'timestamp': dt.datetime.now(dt.timezone.utc).isoformat(),
        'adapterDir': str(out_dir),
    }
    print(f'  post-fine-tune holdout accuracy: {post_summary["accuracy"]:.1%} '
          f'(gain {metrics["gain"]:+.1%}, {train_time}s)', flush=True)
    return metrics, post_rows


def main():
    import os
    import traceback
    env = os.environ.get
    ap = argparse.ArgumentParser()
    ap.add_argument('--bases', nargs='+', default=env('ROUTER_BASES', 'Qwen/Qwen3-4B-Instruct-2507 Qwen/Qwen3.5-4B').split())
    ap.add_argument('--epochs', type=int, default=int(env('ROUTER_EPOCHS', '8')))
    ap.add_argument('--lr', type=float, default=float(env('ROUTER_LR', '2e-4')))
    ap.add_argument('--batch', type=int, default=int(env('ROUTER_BATCH', '4')))
    ap.add_argument('--lora-r', type=int, default=16)
    ap.add_argument('--lora-alpha', type=int, default=32)
    ap.add_argument('--max-len', type=int, default=int(env('ROUTER_MAX_LEN', '512')))
    ap.add_argument('--seed', type=int, default=int(env('ROUTER_SEED', '0')))
    ap.add_argument('--fresh', action='store_true')
    args, _unknown = ap.parse_known_args()  # colab_kernel_launcher injects its own -f flag
    if args.fresh:
        os.environ.pop('LATTICE_RUN_ID', None)

    run = ColabRun('sft')
    gpu = torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'cpu'
    run.emit('config.json', {
        'job': 'sft', 'bases': args.bases, 'epochs': args.epochs, 'lr': args.lr,
        'batch': args.batch, 'loraR': args.lora_r, 'loraAlpha': args.lora_alpha,
        'maxLen': args.max_len, 'seed': args.seed, 'gpu': gpu,
        'torch': torch.__version__,
    }, kind='config')

    random.seed(args.seed)
    torch.manual_seed(args.seed)

    rows = [json.loads(l) for l in CORPUS.read_text().splitlines() if l.strip()]
    train_cases = [r for r in rows if r['split'] == 'train']
    holdout = [r for r in rows if r['split'] == 'holdout']
    examples = build_train_examples(train_cases)
    print(f'corpus: {len(train_cases)} train / {len(holdout)} holdout -> {len(examples)} examples', flush=True)

    all_metrics = []
    for base in args.bases:
        name = f'sft-{base.replace("/", "__")}.json'
        if run.is_done(name):
            print(f'skip {base}: {name} already emitted (resume)', flush=True)
            all_metrics.append(json.loads(run.path_for(name).read_text(encoding='utf-8')))
            continue
        tok, model = load_base(base)
        encoded = [encode_example(tok, ex, args.max_len) for ex in examples]
        print(f'encoded {len(encoded)} examples, max {max(len(e[0]) for e in encoded)} tokens', flush=True)
        del model
        torch.cuda.empty_cache()

        metrics, post_rows = run_base(base, args, train_cases, holdout, examples, encoded, run)
        run.emit(name, metrics)
        run.append_jsonl(f'sft-{base.replace("/", "__")}.rows.jsonl', post_rows, stream=False)
        print(f'  {base}: post-FT {metrics["postFineTune"]["accuracy"]:.1%} '
              f'(gain {metrics["gain"]:+.1%})', flush=True)
        all_metrics.append(metrics)
        del metrics
        torch.cuda.empty_cache()

    if len(all_metrics) == len(args.bases):
        run.complete({'bases': all_metrics})
        print('JOB_COMPLETE', flush=True)
    else:
        run.interrupt('some bases failed; re-run to resume the remainder')
        print('JOB_FAILED', flush=True)
        sys.exit(1)


if __name__ == '__main__':
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        print(traceback.format_exc(limit=6), flush=True)
        print('JOB_FAILED', flush=True)
        sys.exit(1)
