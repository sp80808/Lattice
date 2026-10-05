# Tessera repair: the MVP slice

Lattice repairs a deliberately broken Tessera program, the real `tsr` binary
alone decides success, and each run's rounds, `tsr` verifications, tokens and
cost are compared with a random-choice baseline on the same tasks and seeds
(`docs/mvp.md`, Milestone C).

```bash
# Build tsr once (from a Tessera checkout)
cargo build --release -p tessera-cli
export TSR=$PWD/target/release/tsr

# From Lattice
npm run build
node examples/tessera-repair/compare.mjs              # offline stubs, 5 seeds
node examples/tessera-repair/compare.mjs --generator model --decider model \
  --base-url http://127.0.0.1:11434/v1 --model qwen3-coder \
  --price-in 0 --price-out 0 --out report.json       # a real model
```

## Tasks

Each `tasks/<name>/` has a broken `add.tes` and a `task.json` with the
behaviour `tsr run` must show (`add(2,3)=5`, `add(0,0)=0`, `add(7,-2)=5`).

| task | bug | what rejects it |
|---|---|---|
| `syntax-error` | `a+` | `tsr witness`: `E-syntax-expected` |
| `unbound-name` | `a+c` | `tsr witness`: `E-resolve-unbound-name` |
| `wrong-result` | `a+b+a` | compiles; `tsr run` returns the wrong value |
| `foreign-syntax` | Rust-style `fn add(a: i64, ...) -> i64 { return a + b; }`, as models write TC | `tsr witness`: `E-syntax-foreign` |

## How a run works

1. `tsr witness` runs on the broken program; its JSON document is stored in the
   run log and its diagnostics become verified `build` evidence.
2. Each round the generator proposes candidate files, the decider picks one,
   and the executor verifies it: `tsr witness`, then the `tsr run` cases if it
   compiles. The prompt carries `tsr grammar`, the current file's diagnostics
   rendered with source line, caret and `help`, and the last rejected attempts
   each paired with what `tsr` said about it (see "Why" below).
   Before any generator call, the `suggestions` a `tsr witness` document lists
   (whole files that already pass `tsr check`, e.g. the TC reading of a
   Rust-style program) are offered as candidates at no token cost; they are
   verified like any other. `--no-suggestions` measures the generator alone.
3. Only a candidate `tsr` accepts is written back. The run ends `solved`, or
   `budget_exhausted` after `--max-rounds`.

The two arms share the generator and seeds; only the decider differs. With
`--generator model`, the first arm to reach a round for a task and seed calls
the model and later arms replay that reply (and are charged its tokens), so
every arm chooses from the same candidates:

| arm | decider |
|---|---|
| `heuristic` (default) | offline stand-in: smallest edit, avoids names `tsr` called unbound; no tokens |
| `model:<name>` (`--decider model`) | an OpenAI-compatible decision model |
| `random` | seeded uniform pick among the generated candidates |

The default generator (`--generator stub`) is a seeded mutation enumerator, not a
model, so offline numbers measure the loop's plumbing and the decider alone, not
model quality. Tokens and cost are counted from what the provider reports;
`--price-in`/`--price-out` (USD per million tokens) turn them into cost. Identical
candidate files are verified once per process (`tsr` results are deterministic
per build) and reported as cache hits.

Model calls send `max_tokens` (`--max-tokens`, default 4096); without it some
routers reserve the model's full output limit against your balance. An auth,
billing or rate-limit error (HTTP 401, 402, 403 or 429) stops the comparison
instead of running every remaining task into the same error.

`--claude-code` runs the model arms on the local Claude Code CLI (`claude -p`, no
tools, one call per request) so they use your Claude plan instead of an API key;
`--model` picks the CLI model. Tokens are counted and cost is the CLI's list-price
figure, not what the plan charges. Each call starts a CLI process, so it is slower
than an API.

Every run log keeps every witness document; replay one without `tsr`:

```bash
node --input-type=module -e '
  import { replayRunLog } from "@lattice/tessera";
  console.log(await replayRunLog(process.argv[1]));' <run.jsonl>
```

## Why the prompt and suggestions look like this

First model runs: a local 7B model kept writing C/Rust-style TC after `tsr`
rejected it, and the feedback it saw was a dozen cascading parser errors with
no mention of the TC spelling. The changes follow published results on
feedback quality in self-repair, paired attempt/error feedback, grammar
prompting and deterministic repair of "parent language" output; sources and
measurements are in Tessera's
[`docs/research/2026-10-04-llm-repair.md`](https://github.com/sp80808/Tessera/blob/main/docs/research/2026-10-04-llm-repair.md).
The comparison table's "by tsr suggestion" column counts runs whose verified
patch came from `tsr` rather than the generator.
