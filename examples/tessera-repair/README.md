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

## How a run works

1. `tsr witness` runs on the broken program; its JSON document is stored in the
   run log and its diagnostics become verified `build` evidence.
2. Each round the generator proposes candidate files (the rejected ones are fed
   back so they are not proposed again), the decider picks one, and the
   executor verifies it: `tsr witness`, then the `tsr run` cases if it compiles.
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

Every run log keeps every witness document; replay one without `tsr`:

```bash
node --input-type=module -e '
  import { replayRunLog } from "@lattice/tessera";
  console.log(await replayRunLog(process.argv[1]));' <run.jsonl>
```
