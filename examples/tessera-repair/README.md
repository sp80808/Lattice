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
   verified like any other. `--no-suggestions` measures the generator alone;
   `--ablation` reports both (see "Attribution" below).
   A reply that is not usable JSON does not end the run: its parse error and
   an excerpt go back to the generator, which answers again (two retries per
   round by default, as Roo Code and Cline do with malformed tool calls).
   Every retry is a traced call and its tokens count; `formatErrors` in each
   run report says how many replies were unusable. Candidates with a missing
   field are dropped while their siblings are kept, a raw newline inside a JSON
   string is read as `\n`, and a program wrapped in a markdown fence is
   unwrapped before `tsr` sees it.
   A candidate may also be SEARCH/REPLACE blocks (`<<<<<<< SEARCH` /
   `=======` / `>>>>>>> REPLACE`) applied to the current file, as Roo Code,
   Cline and Kilo Code edit files: matched exactly, then line by line ignoring
   indentation, then ignoring whitespace altogether, and refused when it
   matches several places. An edit that matches nowhere costs no `tsr` call;
   it becomes a rejected attempt whose feedback quotes the closest text in the
   file and its similarity. `--edits` offers this format in the prompt (whole
   files only by default, so earlier numbers stay comparable); `editFailures`
   counts edits that did not apply.
   A candidate that repeats a program already verified is dropped before the
   decider sees it, and so is a second candidate with the same program in one
   reply. Programs are compared as `tsr fmt` spells them, so respacing, line
   breaks or a comment do not make an old attempt new (Agentless dedupes
   normalized patches the same way; OpenHands and opencode stop agents that
   repeat themselves). A reply made only of repeats goes back to the generator
   with the list, like an unusable reply; if the retries are spent, the run
   ends `blocked` as stuck instead of re-running a known result. Reports count
   `repeatsDropped`, `repeatReplies` and the `fmtProcesses` this cost (kept out
   of `tsrProcesses`). `--repeats exact` compares text only, and
   `--repeats allow` verifies repeats again as runs did before.
   `--minimal` adds one rule to the prompt, the repair reading of
   [Ponytail](https://github.com/DietrichGebert/ponytail)'s "lazy senior
   developer" (MIT, idea only): work out what is actually wrong, then make the
   smallest change that fixes it and leave the rest of the file alone. Every
   solved run reports `patchDistance` (characters changed from the broken
   program) so the rule's effect is measured, not assumed.
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

## Attribution: compiler repairs are not model results

A patch `tsr` suggested is a deterministic compiler repair. It must not be
read as a model win, so the report keeps the two apart:

- every verification in the run log carries `lineage`: `candidateSource`
  (`compiler_suggestion` or `model_generator`, the generator slot, which the
  offline stub also fills) and `selectionSource` (`model_decision`,
  `deterministic_policy` for the heuristic/random deciders, or `human`). The
  verdict stays independent: only `tsr` and the cases decide it;
- a run report has `lineage` for the accepted patch and `suggestionRounds`
  (rounds `tsr` answered; these are not counted in `generator`);
- the table splits solves into "by compiler repair", "by generator" and
  "unresolved". "Model tokens / cost per generator patch" divides the model
  spend of every run not solved by a compiler repair by the generator-solved
  runs: that is model efficiency. "End-to-end ... per verified patch" divides
  all spend by all solves: that is workflow cost, not model efficiency.

`suggestions: ON/OFF` heads each table. `--ablation` runs both configurations
and prints both tables (`--out` then holds `withSuggestions` and
`withoutSuggestions`); CI runs it. Offline result (stub generator, heuristic
and random deciders, 5 seeds, `tsr` 2e3dac2):

| task | suggestions ON: solved (compiler / generator) | OFF: solved |
|---|---|---|
| foreign-syntax | 5/5 (5 / 0), both arms | 0/5, both arms |
| unbound-name | 5/5 (5 / 0), both arms | 4/5, both arms |
| syntax-error | 5/5 (0 / 5) | 5/5 |
| wrong-result | 5/5 (0 / 5) | 5/5 |

With suggestions on, the foreign-syntax and unbound-name gains are compiler
repairs. They say nothing about any model; run real models with `--ablation`
to measure what the generator itself solves.
