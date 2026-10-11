# Lattice TUI reference review

Source inspected on 10 October 2026. The choices below are engineering judgments about fit for Lattice, not upstream performance rankings. No upstream source was copied and no framework or runtime dependency was added.

| Capability | Strongest fit and inspected source | Native Lattice application |
| --- | --- | --- |
| Workflow controls | [Gemini approval mode hook](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/ui/hooks/useApprovalModeIndicator.ts), [OpenCode prompt](https://github.com/anomalyco/opencode/blob/dev/packages/tui/src/component/prompt/index.tsx): explicit mode state, central key commands and immediate feedback | Workflow state separate from view state; one reverse-tab handler; service dispatch selects planner or supervised/autopilot coding loop |
| Composer/history | [Gemini input history](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/ui/hooks/useInputHistory.ts), [OpenCode prompt](https://github.com/anomalyco/opencode/blob/dev/packages/tui/src/component/prompt/index.tsx): preserve drafts and deliberately position the cursor after recall | Bounded native Ink editor; completion from the command registry; draft history, cursor navigation and multiline continuation/paste |
| Responsive layout | [Gemini terminal size](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/ui/hooks/useTerminalSize.ts), [Crush header](https://github.com/charmbracelet/crush/blob/main/internal/ui/model/header.go): resize cleanup and compact branding | Resize subscription, activity height follows composer height; mesh only on a spacious welcome screen |
| Approval focus | [Codex approval overlay](https://github.com/openai/codex/blob/main/codex-rs/tui/src/bottom_pane/approval_overlay.rs): explicit decision events and cancellation semantics | Explicit approval key; Enter requires deliberate candidate navigation; Escape stops or leaves refinement; composer inactive during review |
| Execution feedback | [Gemini agent stream](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/ui/hooks/useAgentStream.ts), [Goose output](https://github.com/aaif-goose/goose/blob/main/crates/goose-cli/src/session/output.rs): project runtime events into meaningful public UI summaries | Real TAP/tool/decision/experiment events, model identities, token/cost metadata when reported; no synthetic progress or private reasoning |
| Resource efficiency | [Pi TUI](https://github.com/earendil-works/pi/blob/main/packages/tui/src/tui.ts), [Qwen frame flush](https://github.com/QwenLM/qwen-code/blob/main/packages/cli/src/ui/hooks/use-frame-coalesced-flush.ts): differential rendering and coalescing input bursts | Keep Ink's existing renderer, batch event feed updates, cap visible history at 200 records, retain full run ledger |
| Agent lifecycle | [Pi agent loop](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts): typed tool lifecycle and explicit abort handling | Reuse the isolated agent executor; propagate loop AbortSignal and disclose that active subprocesses finish or time out |
| Semantic identity | [Crush palette](https://github.com/charmbracelet/crush/blob/main/internal/ui/styles/palette.go): accent and semantic roles are separate | Amber PLAN, cyan BUILD, magenta AUTO; green only for verified patches, amber blockers and red failures; ASCII cloth mesh with literal LATTICE wordmark |
| Diff/session inspection | [Codex history](https://github.com/openai/codex/blob/main/codex-rs/tui/src/bottom_pane/chat_composer_history.rs), [Aider input/output](https://github.com/Aider-AI/aider/blob/main/aider/io.py): persistent sessions and explicit multiline interaction | Existing runs/show ledger; typed recorded patch accessor; paged diff includes added files and retained workspace identity |
| Model routing/recovery | [Oh My OpenAgent delegate selection](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/packages/delegate-core/src/model-selection.ts): configured-provider eligibility and explicit fallback choices | Retain Lattice's decision-routed generator pool, budgets and retries; display observed routing/model events instead of adding another router |

Avoided complexity: no OpenTUI/Solid/Bubble Tea/Ratatui migration, second session store, extra model discovery on every render, fabricated reasoning, copied provider stack, or broad theme configuration subsystem. Subagents and dynamic capabilities continue to use existing harness contracts; this repair does not create a second orchestrator.

## Revisions and licences

Repository heads observed during research (UTC commit dates):

| Project | Head | Commit date | Licence checked |
| --- | --- | --- | --- |
| OpenCode | `7b3d4ce3a7db` | 2026-10-10 15:29 | MIT |
| Pi | `4ac0bd8c7b96` | 2026-10-10 15:35 | MIT |
| Crush | `df5b024a929d` | 2026-10-10 10:43 | [FSL-1.1-MIT](https://github.com/charmbracelet/crush/blob/main/LICENSE.md); reference only |
| Codex | `806d9732c974` | 2026-10-10 08:51 | Apache-2.0 |
| Gemini CLI | `9b6e0265d16b` | 2026-10-09 21:57 | Apache-2.0 |
| Qwen Code | `1e1c4a4aeecd` | 2026-10-10 15:39 | Apache-2.0 |
| Goose | `3bd852002903` | 2026-10-09 21:01 | Apache-2.0 |
| Aider | `5dc9490bb35f` | 2026-05-22 14:02 | Apache-2.0 |
| Oh My OpenAgent | `888f25b072be` | 2026-10-10 15:59 | [Sustainable Use License 1.0](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/LICENSE.md); reference only |

Selected inspected file blob SHAs: OpenCode prompt `73f61f329ceefd7a44f64ac91411b9255e99404f`; Gemini mode `1dd6c6468e71535e8aa33547f6be71901a75423d`; Pi TUI `56a983b17644a1b12495ac61a0ed19ed3deef29b`; Crush header `c2cc95bdec3e27e95615d75f878b2339d954ea31`; Codex approvals `6ab14d1f680fc8a8a1f22853fed49709a105c27e`; Qwen coalescing `8d1a4d4a044ed218edbb89db88fa63ac0c338292`; Goose output `7deebb896e94c3cc46ddd5d2a5f35f8a6bfd1760`; Aider I/O `ed6f22d51ae1b1dee249be67f6750498cbf0e905`; OpenAgent model selection `7a602a85be531846a3340a3784915d358217af1a`.

## Operational boundaries

PLAN uses bounded repository source selections and a configured generator. Automatic discovery selects four relevant text sources; `/plan task --file path:start-end` supplies exact context for large or ambiguous requests. Planning records a draft and runs neither workers nor project verification commands.

BUILD changes candidate decision policy to supervised. AUTO changes it to bounded autopilot. Both require coding configuration, Git isolation, an available worker executable and verifier. Worker tool permissions remain those configured for the adapter. No mode automatically applies patches to the target checkout, commits, pushes or deploys. A verified result means an isolated patch passed the configured verifier; it does not establish every natural-language acceptance criterion.

Cancellation stops the loop at supported boundaries. The current worker/provider contracts do not interrupt an active subprocess or model request; the UI keeps waiting and says so. Full model token streaming is not exposed by the current generator contract; completed public summaries and actual tool transitions are displayed. GitHub context is not automatically fetched by the TUI: issue-based work still requires configured retrieval/tools or supplied source context.

Rebuild and launch: `npm run build` in the Lattice checkout, then `lattice -C /path/to/target`. The existing global executable is already linked to `apps/cli`; no relink is required. Run `lattice init` in the selected target and `lattice doctor` to configure and check real providers/agents.

## Verification and measurement

`apps/tui/src/App.test.tsx` drives Ink's input parser with reverse-tab, completion and paging sequences. `scripts/check-tui-pty.py` launches the actual CLI in PTYs, exercises workflow colours, draft preservation, multiline input, missing setup, resize and NO_COLOR, and measures startup/input response.

The optional PTY baseline uses the checkout's pre-change TUI source transpiled into a temporary directory and shares the current service dependencies. It compares terminal presentation startup and input latency; it is not an end-to-end agent throughput benchmark or a comparison of upstream products. Measurements and full quality-gate results are recorded in the final handoff.
