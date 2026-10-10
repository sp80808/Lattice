# Lattice GitHub Issues & Beads Issue Tracking

> Automatically synchronized between GitHub (`sp80808/Lattice`) and local Beads issue database (`.beads`).
> **Total Issues:** 54 (Open: 48, Closed: 6)

## Issue Tracks & Architecture Map

### Tooling, TUI, MCP & Adapters (10)

| # | Title | Priority | State | Beads ID | GitHub Link |
|---|---|---|---|---|---|
| #1 | Bootstrap TypeScript workspace, daemon and `lattice` CLI | P2 | ✓ Closed | `lat-1791647043658-1-6d647d30` | [#1](https://github.com/sp80808/Lattice/issues/1) |
| #8 | Expose Lattice as an MCP server and consume MCP tools | P2 | ○ Open | `lat-1791647044102-8-3c394a32` | [#8](https://github.com/sp80808/Lattice/issues/8) |
| #10 | Build shared TUI and web GUI on the Lattice daemon | P2 | ○ Open | `lat-1791647044235-10-f479d2ad` | [#10](https://github.com/sp80808/Lattice/issues/10) |
| #11 | Add adapters for existing coding-agent ecosystems | P2 | ✓ Closed | `lat-1791647044308-11-3c7cfa78` | [#11](https://github.com/sp80808/Lattice/issues/11) |
| #29 | Public OAuth/device-flow auth for Hugging Face and GitHub research adapters | P2 | ○ Open | `lat-1791647044639-17-fded3ec1` | [#29](https://github.com/sp80808/Lattice/issues/29) |
| #30 | Add first-party scholarly source adapters: Crossref, OpenAlex, Europe PMC, Semantic Scholar and arXiv | P2 | ○ Open | `lat-1791647044695-18-d6d995a1` | [#30](https://github.com/sp80808/Lattice/issues/30) |
| #33 | Structured code actions: symbol/AST read-edit adapter with syntax-validated patches | P2 | ○ Open | `lat-1791647044889-21-6d656a01` | [#33](https://github.com/sp80808/Lattice/issues/33) |
| #66 | P0: Progressive MCP tool discovery and capability-scoped tool registry | **P0** | ○ Open | `lat-1791647046316-40-7f475d1b` | [#66](https://github.com/sp80808/Lattice/issues/66) |
| #68 | P1: Portable skill packs and agent workflow recipes with lazy loading | **P1** | ○ Open | `lat-1791647046427-42-47ab30f4` | [#68](https://github.com/sp80808/Lattice/issues/68) |
| #77 | P2: Prototype an OpenTUI-powered Lattice client against the existing daemon | P2 | ○ Open | `lat-1791647047019-51-63f1950e` | [#77](https://github.com/sp80808/Lattice/issues/77) |

### Context, Evidence & Research Federation (10)

| # | Title | Priority | State | Beads ID | GitHub Link |
|---|---|---|---|---|---|
| #2 | Specify and implement Tessera Agent Packet (TAP) v0 | P2 | ○ Open | `lat-1791647043743-2-ca903d59` | [#2](https://github.com/sp80808/Lattice/issues/2) |
| #5 | Implement evidence-first repository context and execution layer | P2 | ○ Open | `lat-1791647043933-5-1e1a9472` | [#5](https://github.com/sp80808/Lattice/issues/5) |
| #23 | L3: Compress TAP and context packets with reversible Tessera representations | P2 | ○ Open | `lat-1791647044466-14-bbe53bbf` | [#23](https://github.com/sp80808/Lattice/issues/23) |
| #28 | Research federation v0: normalize external sources into TAP evidence | P2 | ○ Open | `lat-1791647044582-16-4077c615` | [#28](https://github.com/sp80808/Lattice/issues/28) |
| #42 | D3/D4: measure Tessera structural-context ablations on Tessera and Lattice | P2 | ○ Open | `lat-1791647045343-28-01760406` | [#42](https://github.com/sp80808/Lattice/issues/42) |
| #55 | Make TAP token/cost budgets enforceable instead of round-count metadata | P2 | ○ Open | `lat-1791647046051-38-6246b131` | [#55](https://github.com/sp80808/Lattice/issues/55) |
| #56 | Fault-isolate top-k experiments so one executor error does not discard sibling evidence | P2 | ○ Open | `lat-1791647046255-39-1e79cf59` | [#56](https://github.com/sp80808/Lattice/issues/56) |
| #73 | P0: Reversible type-aware tool-output compression with evidence-preserving retrieval | **P0** | ○ Open | `lat-1791647046778-47-8b7de79e` | [#73](https://github.com/sp80808/Lattice/issues/73) |
| #75 | P1: Hybrid provenance-aware retrieval across code, docs, diagnostics and external evidence | **P1** | ○ Open | `lat-1791647046898-49-aa57639d` | [#75](https://github.com/sp80808/Lattice/issues/75) |
| #78 | Roadmap: upstream harness adaptations with evidence gates and implementation order | P2 | ○ Open | `lat-1791647047085-52-531cc697` | [#78](https://github.com/sp80808/Lattice/issues/78) |

### Routing, Policy & Decision Layer (9)

| # | Title | Priority | State | Beads ID | GitHub Link |
|---|---|---|---|---|---|
| #3 | Implement pluggable generator and decision-provider interfaces | P2 | ○ Open | `lat-1791647043808-3-72c2df0c` | [#3](https://github.com/sp80808/Lattice/issues/3) |
| #4 | Build Qwen-first bounded decision engine | P2 | ○ Open | `lat-1791647043867-4-87e9595b` | [#4](https://github.com/sp80808/Lattice/issues/4) |
| #21 | L1: Calibrate provider routing from verified decision outcomes | P2 | ✓ Closed | `lat-1791647044361-12-32f0fe0d` | [#21](https://github.com/sp80808/Lattice/issues/21) |
| #22 | L2: Mine deterministic decision rules and Tessera context tiles | P2 | ○ Open | `lat-1791647044414-13-5f883373` | [#22](https://github.com/sp80808/Lattice/issues/22) |
| #31 | Evidence routing: source capability index, uncertainty triggers and proof-of-use links | P2 | ○ Open | `lat-1791647044777-19-5ced2d13` | [#31](https://github.com/sp80808/Lattice/issues/31) |
| #46 | L5: log action propensities and add doubly-robust off-policy evaluation for routing/search policies | P2 | ○ Open | `lat-1791647045412-29-d53ea798` | [#46](https://github.com/sp80808/Lattice/issues/46) |
| #74 | P1: Minimal verified patch policy: reuse-first, root-cause edits and complexity regression checks | **P1** | ○ Open | `lat-1791647046835-48-ae1ef2ac` | [#74](https://github.com/sp80808/Lattice/issues/74) |
| #76 | P1: Live model capability and pricing registry for verified cost-aware routing | **P1** | ○ Open | `lat-1791647046955-50-bd264110` | [#76](https://github.com/sp80808/Lattice/issues/76) |
| #86 | P0: Contextual decision/question routing with accuracy-gated Jev-style primitives | **P0** | ○ Open | `lat-1791647047156-53-f36b86fe` | [#86](https://github.com/sp80808/Lattice/issues/86) |

### General & Core Architecture (4)

| # | Title | Priority | State | Beads ID | GitHub Link |
|---|---|---|---|---|---|
| #6 | Implement generate → decide → experiment → verify search loop | P2 | ○ Open | `lat-1791647043991-6-637200f9` | [#6](https://github.com/sp80808/Lattice/issues/6) |
| #47 | Failure-aware stop / restart / recover / escalate controller with retry-adjusted workflow cost | P2 | ○ Open | `lat-1791647045485-30-245f56cc` | [#47](https://github.com/sp80808/Lattice/issues/47) |
| #48 | L1 correctness: intervention-aware candidate/outcome attribution for calibration and policy mining | P2 | ○ Open | `lat-1791647045562-31-c3c528fa` | [#48](https://github.com/sp80808/Lattice/issues/48) |
| #70 | P0: Explicit Plan / Act / Debug / Review modes with enforced tool permissions | **P0** | ○ Open | `lat-1791647046556-44-d6aea7fa` | [#70](https://github.com/sp80808/Lattice/issues/70) |

### Multi-Agent Orchestration & Swarms (3)

| # | Title | Priority | State | Beads ID | GitHub Link |
|---|---|---|---|---|---|
| #7 | Add isolated git-worktree subagent orchestration | P2 | ○ Open | `lat-1791647044050-7-fe59219e` | [#7](https://github.com/sp80808/Lattice/issues/7) |
| #53 | Fix parallel-agent verification: preserve structured Verifier semantics in scheduler and survivor selection | P2 | ✓ Closed | `lat-1791647045915-36-8eb7801f` | [#53](https://github.com/sp80808/Lattice/issues/53) |
| #89 | P0 integration: adaptive project-aware capability planning and verified one-shot coding | **P0** | ○ Open | `lat-1791647047218-54-5fa1128f` | [#89](https://github.com/sp80808/Lattice/issues/89) |

### Benchmarking, Evaluation & Dogfooding (9)

| # | Title | Priority | State | Beads ID | GitHub Link |
|---|---|---|---|---|---|
| #9 | Create benchmark harness for cost, accuracy, latency and hallucination rate | P2 | ○ Open | `lat-1791647044164-9-6a389463` | [#9](https://github.com/sp80808/Lattice/issues/9) |
| #32 | Live research probes + evaluation harness for cost, grounding and source diversity | P2 | ○ Open | `lat-1791647044834-20-3eccb3dc` | [#32](https://github.com/sp80808/Lattice/issues/32) |
| #34 | Repository preflight: retrieval benchmark, task refinement and abstention before coding | P2 | ○ Open | `lat-1791647044942-22-08e93d22` | [#34](https://github.com/sp80808/Lattice/issues/34) |
| #36 | D7 external generalisation gate: prove Lattice advantage on WavedStudio, HÅW and RST | P2 | ○ Open | `lat-1791647045002-23-4f351d39` | [#36](https://github.com/sp80808/Lattice/issues/36) |
| #39 | P0 self-dogfood ladder: make Tessera + Lattice improve themselves before external validation | **P0** | ○ Open | `lat-1791647045125-25-fa36e23d` | [#39](https://github.com/sp80808/Lattice/issues/39) |
| #40 | D1: consume real `tsr witness` evidence through TAP and replay ledger | P2 | ○ Open | `lat-1791647045197-26-43a0b0c6` | [#40](https://github.com/sp80808/Lattice/issues/40) |
| #41 | D2: build frozen historical self-dogfood corpus from real Lattice/Tessera regressions | P2 | ○ Open | `lat-1791647045274-27-c84bc4d1` | [#41](https://github.com/sp80808/Lattice/issues/41) |
| #49 | Harden dogfood/evaluation against reward hacking, weak tests and benchmark leakage | P2 | ○ Open | `lat-1791647045662-32-759c6d7f` | [#49](https://github.com/sp80808/Lattice/issues/49) |
| #69 | P1: Harness capability matrix and model×harness comparative evaluation | **P1** | ○ Open | `lat-1791647046489-43-597bfe48` | [#69](https://github.com/sp80808/Lattice/issues/69) |

### Runtime, Security & Fault Isolation (9)

| # | Title | Priority | State | Beads ID | GitHub Link |
|---|---|---|---|---|---|
| #24 | L4: Add offline policy replay and held-out policy simulation | P2 | ✓ Closed | `lat-1791647044527-15-4e9051df` | [#24](https://github.com/sp80808/Lattice/issues/24) |
| #38 | P0 QC: prevent red-main merges and false-green example checks | **P0** | ✓ Closed | `lat-1791647045061-24-77a605d1` | [#38](https://github.com/sp80808/Lattice/issues/38) |
| #50 | Make evidence identity deterministic and content-addressed across replay runs | P2 | ○ Open | `lat-1791647045724-33-003885a5` | [#50](https://github.com/sp80808/Lattice/issues/50) |
| #51 | Add strict deterministic run replay and event-level forking from recorded model/tool I/O | P2 | ○ Open | `lat-1791647045782-34-7d8a5963` | [#51](https://github.com/sp80808/Lattice/issues/51) |
| #52 | P0 execution security: sandbox autonomous workers, minimize secrets, and treat repos as untrusted input | **P0** | ○ Open | `lat-1791647045841-35-bdcd8222` | [#52](https://github.com/sp80808/Lattice/issues/52) |
| #54 | Make captured candidate changes complete and immutable before verification/promotion | P2 | ○ Open | `lat-1791647045979-37-2c45b062` | [#54](https://github.com/sp80808/Lattice/issues/54) |
| #67 | P0: Durable agent sessions and checkpoint-resume with TAP replay safety | **P0** | ○ Open | `lat-1791647046370-41-3d44a388` | [#67](https://github.com/sp80808/Lattice/issues/67) |
| #71 | P0: Interactive edit checkpoints, diffs and selective undo without losing agent evidence | **P0** | ○ Open | `lat-1791647046636-45-123332af` | [#71](https://github.com/sp80808/Lattice/issues/71) |
| #72 | P0: Harden streamed tool/terminal lifecycle, cancellation and child-task state races | **P0** | ○ Open | `lat-1791647046708-46-5bf86a24` | [#72](https://github.com/sp80808/Lattice/issues/72) |

## Complete Issue Directory

| # | Title | Category | State | Beads ID |
|---|---|---|---|---|
| [#1](https://github.com/sp80808/Lattice/issues/1) | Bootstrap TypeScript workspace, daemon and `lattice` CLI | Tooling, TUI, MCP & Adapters | Closed | `lat-1791647043658-1-6d647d30` |
| [#2](https://github.com/sp80808/Lattice/issues/2) | Specify and implement Tessera Agent Packet (TAP) v0 | Context, Evidence & Research Federation | Open | `lat-1791647043743-2-ca903d59` |
| [#3](https://github.com/sp80808/Lattice/issues/3) | Implement pluggable generator and decision-provider interfaces | Routing, Policy & Decision Layer | Open | `lat-1791647043808-3-72c2df0c` |
| [#4](https://github.com/sp80808/Lattice/issues/4) | Build Qwen-first bounded decision engine | Routing, Policy & Decision Layer | Open | `lat-1791647043867-4-87e9595b` |
| [#5](https://github.com/sp80808/Lattice/issues/5) | Implement evidence-first repository context and execution layer | Context, Evidence & Research Federation | Open | `lat-1791647043933-5-1e1a9472` |
| [#6](https://github.com/sp80808/Lattice/issues/6) | Implement generate → decide → experiment → verify search loop | General & Core Architecture | Open | `lat-1791647043991-6-637200f9` |
| [#7](https://github.com/sp80808/Lattice/issues/7) | Add isolated git-worktree subagent orchestration | Multi-Agent Orchestration & Swarms | Open | `lat-1791647044050-7-fe59219e` |
| [#8](https://github.com/sp80808/Lattice/issues/8) | Expose Lattice as an MCP server and consume MCP tools | Tooling, TUI, MCP & Adapters | Open | `lat-1791647044102-8-3c394a32` |
| [#9](https://github.com/sp80808/Lattice/issues/9) | Create benchmark harness for cost, accuracy, latency and hallucination rate | Benchmarking, Evaluation & Dogfooding | Open | `lat-1791647044164-9-6a389463` |
| [#10](https://github.com/sp80808/Lattice/issues/10) | Build shared TUI and web GUI on the Lattice daemon | Tooling, TUI, MCP & Adapters | Open | `lat-1791647044235-10-f479d2ad` |
| [#11](https://github.com/sp80808/Lattice/issues/11) | Add adapters for existing coding-agent ecosystems | Tooling, TUI, MCP & Adapters | Closed | `lat-1791647044308-11-3c7cfa78` |
| [#21](https://github.com/sp80808/Lattice/issues/21) | L1: Calibrate provider routing from verified decision outcomes | Routing, Policy & Decision Layer | Closed | `lat-1791647044361-12-32f0fe0d` |
| [#22](https://github.com/sp80808/Lattice/issues/22) | L2: Mine deterministic decision rules and Tessera context tiles | Routing, Policy & Decision Layer | Open | `lat-1791647044414-13-5f883373` |
| [#23](https://github.com/sp80808/Lattice/issues/23) | L3: Compress TAP and context packets with reversible Tessera representations | Context, Evidence & Research Federation | Open | `lat-1791647044466-14-bbe53bbf` |
| [#24](https://github.com/sp80808/Lattice/issues/24) | L4: Add offline policy replay and held-out policy simulation | Runtime, Security & Fault Isolation | Closed | `lat-1791647044527-15-4e9051df` |
| [#28](https://github.com/sp80808/Lattice/issues/28) | Research federation v0: normalize external sources into TAP evidence | Context, Evidence & Research Federation | Open | `lat-1791647044582-16-4077c615` |
| [#29](https://github.com/sp80808/Lattice/issues/29) | Public OAuth/device-flow auth for Hugging Face and GitHub research adapters | Tooling, TUI, MCP & Adapters | Open | `lat-1791647044639-17-fded3ec1` |
| [#30](https://github.com/sp80808/Lattice/issues/30) | Add first-party scholarly source adapters: Crossref, OpenAlex, Europe PMC, Semantic Scholar and arXiv | Tooling, TUI, MCP & Adapters | Open | `lat-1791647044695-18-d6d995a1` |
| [#31](https://github.com/sp80808/Lattice/issues/31) | Evidence routing: source capability index, uncertainty triggers and proof-of-use links | Routing, Policy & Decision Layer | Open | `lat-1791647044777-19-5ced2d13` |
| [#32](https://github.com/sp80808/Lattice/issues/32) | Live research probes + evaluation harness for cost, grounding and source diversity | Benchmarking, Evaluation & Dogfooding | Open | `lat-1791647044834-20-3eccb3dc` |
| [#33](https://github.com/sp80808/Lattice/issues/33) | Structured code actions: symbol/AST read-edit adapter with syntax-validated patches | Tooling, TUI, MCP & Adapters | Open | `lat-1791647044889-21-6d656a01` |
| [#34](https://github.com/sp80808/Lattice/issues/34) | Repository preflight: retrieval benchmark, task refinement and abstention before coding | Benchmarking, Evaluation & Dogfooding | Open | `lat-1791647044942-22-08e93d22` |
| [#36](https://github.com/sp80808/Lattice/issues/36) | D7 external generalisation gate: prove Lattice advantage on WavedStudio, HÅW and RST | Benchmarking, Evaluation & Dogfooding | Open | `lat-1791647045002-23-4f351d39` |
| [#38](https://github.com/sp80808/Lattice/issues/38) | P0 QC: prevent red-main merges and false-green example checks | Runtime, Security & Fault Isolation | Closed | `lat-1791647045061-24-77a605d1` |
| [#39](https://github.com/sp80808/Lattice/issues/39) | P0 self-dogfood ladder: make Tessera + Lattice improve themselves before external validation | Benchmarking, Evaluation & Dogfooding | Open | `lat-1791647045125-25-fa36e23d` |
| [#40](https://github.com/sp80808/Lattice/issues/40) | D1: consume real `tsr witness` evidence through TAP and replay ledger | Benchmarking, Evaluation & Dogfooding | Open | `lat-1791647045197-26-43a0b0c6` |
| [#41](https://github.com/sp80808/Lattice/issues/41) | D2: build frozen historical self-dogfood corpus from real Lattice/Tessera regressions | Benchmarking, Evaluation & Dogfooding | Open | `lat-1791647045274-27-c84bc4d1` |
| [#42](https://github.com/sp80808/Lattice/issues/42) | D3/D4: measure Tessera structural-context ablations on Tessera and Lattice | Context, Evidence & Research Federation | Open | `lat-1791647045343-28-01760406` |
| [#46](https://github.com/sp80808/Lattice/issues/46) | L5: log action propensities and add doubly-robust off-policy evaluation for routing/search policies | Routing, Policy & Decision Layer | Open | `lat-1791647045412-29-d53ea798` |
| [#47](https://github.com/sp80808/Lattice/issues/47) | Failure-aware stop / restart / recover / escalate controller with retry-adjusted workflow cost | General & Core Architecture | Open | `lat-1791647045485-30-245f56cc` |
| [#48](https://github.com/sp80808/Lattice/issues/48) | L1 correctness: intervention-aware candidate/outcome attribution for calibration and policy mining | General & Core Architecture | Open | `lat-1791647045562-31-c3c528fa` |
| [#49](https://github.com/sp80808/Lattice/issues/49) | Harden dogfood/evaluation against reward hacking, weak tests and benchmark leakage | Benchmarking, Evaluation & Dogfooding | Open | `lat-1791647045662-32-759c6d7f` |
| [#50](https://github.com/sp80808/Lattice/issues/50) | Make evidence identity deterministic and content-addressed across replay runs | Runtime, Security & Fault Isolation | Open | `lat-1791647045724-33-003885a5` |
| [#51](https://github.com/sp80808/Lattice/issues/51) | Add strict deterministic run replay and event-level forking from recorded model/tool I/O | Runtime, Security & Fault Isolation | Open | `lat-1791647045782-34-7d8a5963` |
| [#52](https://github.com/sp80808/Lattice/issues/52) | P0 execution security: sandbox autonomous workers, minimize secrets, and treat repos as untrusted input | Runtime, Security & Fault Isolation | Open | `lat-1791647045841-35-bdcd8222` |
| [#53](https://github.com/sp80808/Lattice/issues/53) | Fix parallel-agent verification: preserve structured Verifier semantics in scheduler and survivor selection | Multi-Agent Orchestration & Swarms | Closed | `lat-1791647045915-36-8eb7801f` |
| [#54](https://github.com/sp80808/Lattice/issues/54) | Make captured candidate changes complete and immutable before verification/promotion | Runtime, Security & Fault Isolation | Open | `lat-1791647045979-37-2c45b062` |
| [#55](https://github.com/sp80808/Lattice/issues/55) | Make TAP token/cost budgets enforceable instead of round-count metadata | Context, Evidence & Research Federation | Open | `lat-1791647046051-38-6246b131` |
| [#56](https://github.com/sp80808/Lattice/issues/56) | Fault-isolate top-k experiments so one executor error does not discard sibling evidence | Context, Evidence & Research Federation | Open | `lat-1791647046255-39-1e79cf59` |
| [#66](https://github.com/sp80808/Lattice/issues/66) | P0: Progressive MCP tool discovery and capability-scoped tool registry | Tooling, TUI, MCP & Adapters | Open | `lat-1791647046316-40-7f475d1b` |
| [#67](https://github.com/sp80808/Lattice/issues/67) | P0: Durable agent sessions and checkpoint-resume with TAP replay safety | Runtime, Security & Fault Isolation | Open | `lat-1791647046370-41-3d44a388` |
| [#68](https://github.com/sp80808/Lattice/issues/68) | P1: Portable skill packs and agent workflow recipes with lazy loading | Tooling, TUI, MCP & Adapters | Open | `lat-1791647046427-42-47ab30f4` |
| [#69](https://github.com/sp80808/Lattice/issues/69) | P1: Harness capability matrix and model×harness comparative evaluation | Benchmarking, Evaluation & Dogfooding | Open | `lat-1791647046489-43-597bfe48` |
| [#70](https://github.com/sp80808/Lattice/issues/70) | P0: Explicit Plan / Act / Debug / Review modes with enforced tool permissions | General & Core Architecture | Open | `lat-1791647046556-44-d6aea7fa` |
| [#71](https://github.com/sp80808/Lattice/issues/71) | P0: Interactive edit checkpoints, diffs and selective undo without losing agent evidence | Runtime, Security & Fault Isolation | Open | `lat-1791647046636-45-123332af` |
| [#72](https://github.com/sp80808/Lattice/issues/72) | P0: Harden streamed tool/terminal lifecycle, cancellation and child-task state races | Runtime, Security & Fault Isolation | Open | `lat-1791647046708-46-5bf86a24` |
| [#73](https://github.com/sp80808/Lattice/issues/73) | P0: Reversible type-aware tool-output compression with evidence-preserving retrieval | Context, Evidence & Research Federation | Open | `lat-1791647046778-47-8b7de79e` |
| [#74](https://github.com/sp80808/Lattice/issues/74) | P1: Minimal verified patch policy: reuse-first, root-cause edits and complexity regression checks | Routing, Policy & Decision Layer | Open | `lat-1791647046835-48-ae1ef2ac` |
| [#75](https://github.com/sp80808/Lattice/issues/75) | P1: Hybrid provenance-aware retrieval across code, docs, diagnostics and external evidence | Context, Evidence & Research Federation | Open | `lat-1791647046898-49-aa57639d` |
| [#76](https://github.com/sp80808/Lattice/issues/76) | P1: Live model capability and pricing registry for verified cost-aware routing | Routing, Policy & Decision Layer | Open | `lat-1791647046955-50-bd264110` |
| [#77](https://github.com/sp80808/Lattice/issues/77) | P2: Prototype an OpenTUI-powered Lattice client against the existing daemon | Tooling, TUI, MCP & Adapters | Open | `lat-1791647047019-51-63f1950e` |
| [#78](https://github.com/sp80808/Lattice/issues/78) | Roadmap: upstream harness adaptations with evidence gates and implementation order | Context, Evidence & Research Federation | Open | `lat-1791647047085-52-531cc697` |
| [#86](https://github.com/sp80808/Lattice/issues/86) | P0: Contextual decision/question routing with accuracy-gated Jev-style primitives | Routing, Policy & Decision Layer | Open | `lat-1791647047156-53-f36b86fe` |
| [#89](https://github.com/sp80808/Lattice/issues/89) | P0 integration: adaptive project-aware capability planning and verified one-shot coding | Multi-Agent Orchestration & Swarms | Open | `lat-1791647047218-54-5fa1128f` |
