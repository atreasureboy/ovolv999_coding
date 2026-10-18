# Second Audit Repairs Implementation Plan

> **For agentic workers:** Use systematic-debugging and test-driven-development for each task; independently owned domains may execute in parallel. Root integrates shared interfaces and performs final verification and review.

**Goal:** Close all 13 confirmed findings from the second audit with production-path regression coverage.

**Architecture:** Preserve the current agent service and execution architecture. Consolidate permission decisions, active configuration, model admission, persistence identities and public export projections at their existing shared boundaries rather than adding parallel implementations.

**Tech Stack:** TypeScript strict ESM, Node >=22.13.0, Vitest, Ink/React, current Windows execution host.

**Spec:** `.artifacts/audit-2026-10-16-r2/audit.md` and its domain reports/probes, baseline `696ea2424d3f387b467264effea15345743cce95`.

## Global Constraints

- Keep existing CLI and stored data compatible unless a confirmed incorrect behavior must change.
- No new source comments; use existing neighboring patterns; tests belong in `tests/`.
- No paid model requests or user credentials. Use temporary workspaces and local model fixtures.
- No agent commits, package builds or full suite runs while other agents are editing. Root owns integration, build, full verification and commits.
- Continue in the user-selected clean checkout on `codex/module-refinement`; no new checkout, dependency upgrade or unrelated refactor.
- Each task records an observed failing regression, minimal implementation, passing focused checks and any scope limitation under `.artifacts/repairs-2026-10-16-r2/`.

## Review Focus

- Shell commands must receive the same policy across foreground/background tools; explicit deny rules and strict ask remain stronger than convenience defaults.
- Configuration must affect the next real request and survive session switch/restart without silently changing provider identity or retaining invalid continuation state.
- Budget admission must account for retries, auxiliary calls, concurrency, failures and missing usage; unknown price cannot silently bypass a configured cost limit.
- Cancellation and storage failures must preserve evidence, release only owned resources and leave subsequent legitimate operations usable.
- Share formats must not expose hidden native state; raw backup compatibility must remain explicitly distinguishable from public export.

## Task 1: Shell approval parity (X1, X2) — root

**Files:** `src/core/riskClassifier.ts`, `src/core/engine.ts`, relevant tool metadata/types if needed; `tests/riskClassifier.test.ts`, new engine integration coverage in `tests/core/engine/`.

- [x] Add failing real-tool regressions for the audit's harmless file side effects, default/acceptEdits policy, explicit deny and safe read controls.
- [x] Make safe command classification conservative about side-effecting options and apply command risk to background shell execution as well as Bash.
- [x] Run targeted classifier/engine/task/permission tests, observing no unauthorized marker file and no leaked process.

## Task 2: Active profile, mode and Ink state (C1, C2, E2, E3) — configuration worker

**Files:** `src/core/profiles.ts`, `src/commands/{resourcesCommands,configurationCommands,index}.ts`, `src/cli/{repl,permissions}.ts`, `bin/ovogogogo.ts`, `src/ui/ink/{replController,App,runInkRepl}.tsx/ts`, config helpers as needed; CLI/commands/Ink tests.

**Interface boundary:** Root owns engine.ts; request a small engine configuration API if needed. Worker owns command contexts and CLI assembly. Do not edit budget handlers except when coordination explicitly requires it.

- [x] Add failing regressions for strict profile next request/restart, mode prompt next request, persisted Ink deny rules, model-specific rendered context pressure and model change.
- [x] Apply active profile through shared runtime configuration, with explicit precedence and correct model/provider continuation handling. Make mode prompts current rather than captured.
- [x] Reuse permission persistence in Ink and derive status from current model runtime and shared token estimation.
- [x] Verify actual request payloads, file effects, reload and rendered status, not only command success messages.

## Task 3: Model admission and error recovery (M1, M2) — model worker

**Files:** `src/core/{budget,modelGateway}.ts`, `src/core/model/{transport,types,common}.ts` and narrow helpers; model gateway/budget/engine integration tests.

**Interface boundary:** Do not edit engine.ts or resourcesCommands.ts concurrently; coordinate needed changes with root/configuration worker.

- [x] Add failing actual-request regressions for request limit enforcement and automatic usage, bounded concurrency/retries, missing usage and cost pricing; add native HTTP context overflow recovery cases.
- [x] Connect project budgets at shared model request admission/settlement, reserve before dispatch, persist accounting safely, and give unknown usage a conservative explicit contract.
- [x] Parse bounded provider error details and preserve context classification without exposing sensitive raw response bodies.
- [x] Run focused model, admission, cost and budget tests, covering all three protocols where behavior differs.

## Task 4: Approval payload and persistent state (S1, S2, M3) — persistence worker

**Files:** `src/core/{agentService,sessionManager,semanticMemory,episodicMemory}.ts`, `src/core/engine/approval.ts`, persistence helpers if needed; agent service/session/memory tests.

- [x] Add failing regressions for 140000-byte approval input with a usable next turn, canonical/junction ownership reuse and damaged JSONL tails.
- [x] Keep complete approval identity while bounding durable/display previews; preserve review integrity and avoid quarantining untouched workspace on this known size case.
- [x] Canonicalize session writer identity consistently for claim/save/release; retain error behavior for genuinely different owners.
- [x] Repair append boundaries under the existing persistence lock while retaining damaged bytes and prior readable records.
- [x] Verify small/large ask/deny/auto, cross-session isolation, real junction restore and read-after-restart behavior.

## Task 5: ACP cancellation under blocked output (E1) — root

**Files:** `src/cli/acp.ts`, shared output pump if needed, ACP and output tests/fixtures.

- [x] Convert real stopped-pipe audit probe into a failing regression.
- [x] Reuse isolated bounded output with ordering, flush and cancellation semantics; preserve RPC error/EOF behavior.
- [x] Verify cancellation terminal persistence before consuming output and normal lossless delivery when consumer resumes.

## Task 6: Safe public JSON export (E4) — root

**Files:** `src/utils/sessionExport.ts`, `src/commands/transcriptCommands.ts`; export/command tests.

- [x] Add failing export tests with real-shaped provider continuation containing hidden reasoning, plus tool/system filtering and backup compatibility.
- [x] Project public messages explicitly and honor export options. Keep raw backup behavior separate if required by existing import/export contracts.
- [x] Verify JSON sharing excludes hidden state while preserving visible text/tool data and source history remains unchanged.

## Task 7: Integration, review and delivery — root

- [x] Inspect every domain diff and run typecheck plus focused integration tests; resolve shared API/behavior conflicts.
- [x] Run complete Vitest suite, lint, production build, package smoke and relevant offline coding checks on the final implementation.
- [x] Obtain fresh independent code review of changes from baseline, including the five Review Focus conditions; fix material issues with regressions.
- [x] Record exact evidence, remaining platform/provider limitations, final source/build identity; commit coherent verified changes and push the existing authorized GitHub branch.

## Decisions and Progress

- User explicitly requested repair of the completed audit; its remediation scope is the approved design. No additional design-approval pause is required.
- The checkout was clean at the start and already held the user's ongoing branch and audit fixtures. Shared-file ownership remained explicit during parallel implementation.
- Shell classification uses tool metadata for both Bash and TaskCreate. Unknown options for programs with known write/execute flags require approval; strict profiles require approval even for read-only tools, with explicit deny still stronger.
- Runtime configuration updates the existing SDK client and engine config together. Explicit provider/protocol transitions validate the old continuation before discarding it; modified visible history is still rejected.
- Project model budgets reserve durably before each dispatched attempt, including auxiliary requests and retries. The original project budget root is inherited by child agents even inside worktrees. Missing or inconsistent provider usage is charged conservatively; a configured enforced cost budget requires known model pricing. Capacity reservation is deliberately conservative and may reject a small token/cost limit before sending a short prompt.
- ACP and exec share an ordered, bounded output pump. On Windows redirected stdout is written by an isolated helper, so a stopped consumer cannot block cancellation in the agent process. Regression coverage includes SIGINT/SIGTERM/SIGHUP handlers, protocol interrupt, EOF, resumed consumers and listener cleanup.
- Public JSON sharing projects visible fields and honors reasoning/tool filters. Explicit `/export json` retains raw backup compatibility, including internal provider continuation; it is distinct from `/share json`.
- Root targeted evidence: shell/runtime/ACP integration 190 checks passed; output/export 50 checks passed; extended ACP controls 6 checks passed. Configuration coverage includes source CLI restart, pipe, real Ink denial after reloading settings and rendered model changes. Model coverage includes two Node processes and parent-to-worktree budget inheritance. Storage coverage includes canonical and aliased paths, old session identities, damaged tails and process fixtures.

## Final Integration Evidence — 2026-10-18

- Typecheck: `node node_modules/typescript/bin/tsc --noEmit`, exit 0. Full lint: `node node_modules/eslint/bin/eslint.js src/ bin/ tests/ --ext .ts,.tsx`, exit 0. Logs: `.artifacts/repairs-2026-10-16-r2/root/{typecheck-final,lint-final}.log`; the subsequent Ink assertion-only adjustment also passed targeted lint.
- First full run caught two old Ink expectations using `content.length / 4`; independently checking shared message/role overhead gave 57 and 14 tokens. Only those assertions changed; the active projection and message-count assertions remain. Their focused checks passed 27 tests.
- Final full run: `node node_modules/vitest/vitest.mjs run --maxWorkers=4`, **324 files / 5087 tests passed / 14 existing skips**, exit 0, 132.05 seconds. Log: `.artifacts/repairs-2026-10-16-r2/root/full-tests-final.log`.
- Production build: `node scripts/build.mjs`, exit 0. Source SHA256: `608384f3bebd3c213821a085d3c13b7d4ba1c0427137a4d4a22d0e8f1a559cc1`. The initial validation build was made from the uncommitted repair tree; build identity records that fact.
- Installed package: `pnpm run test:package`, **24 cases passed**, exit 0, 136573 ms. The first attempt timed out downloading/checking registry metadata at 180 seconds; the unchanged command succeeded on retry with frozen dependency versions and checks intact. Logs: `.artifacts/repairs-2026-10-16-r2/root/package-smoke{,-retry}.log`; report: `.artifacts/production/release-package-smoke.json`. Validated tarball SHA256: `55f8970ed7923d7ed32fb04352af38cf75165cf9df3c03143cb6e4f3b4822817`, with the source hash above and `sourceDirty: true` before commit.
- Both the local build and installed package passed all **12 offline coding fixture contracts**: 10 completed tasks plus expected cancellation/recovery and conflict outcomes. Local command: `node scripts/agent-eval.mjs --offline --output .artifacts/repairs-2026-10-16-r2/root/offline-eval-local`. Installed evidence: `.artifacts/release-package-M94SLC/coding-evaluation/report.json`. These results qualify harness behavior, not paid-model quality.
- Short soak: `node scripts/soak.mjs --profile short`, exit 0, 152 completed MCP requests; final pending/queued/buffered counts all zero and client closed. Log: `.artifacts/repairs-2026-10-16-r2/root/soak-short.log`; report: `.artifacts/production/release-soak-short.json`. This does not replace the separate long-soak contract.
- Fresh independent review found no remaining confirmed P1/P2 defect. It independently ran 145 checks across shell, export, memory, session aliases and runtime profiles. Its startup-failure listener finding was reproduced, fixed by constructing the output pump after the engine/client, and covered by a regression. Suspected Git option abbreviation and child-prompt regressions were investigated and rejected based on actual Git behavior and child configuration respectively.
- Accepted limits: conservative full-capacity budget admission can reject small requests; uncertain billing and crash reservations are not automatically refunded. Windows/local offline checks do not establish Linux/macOS, native OS signal, paid provider, power-loss or long-soak qualification. The README documents budget and public-share versus raw-backup behavior.

## GitHub Delivery — 2026-10-18

- Published the repair as `0fa82f5508b72cfc4501004369e20d06e36b72ef` on `atreasureboy/ovolv999_coding`, branch `codex/module-refinement`, after explicit destination confirmation. The remote branch was read back and the fetched commit was verified locally.
- GitHub's tree `625c5e65cf88b0a173f9d0c1926e0ca0298f796c` exactly matches the verified local repair commit `5f24795e8bd6ae8b6ff5bbe9b6c084f70cfed1f3`. GitHub API delivery changed commit metadata only; local branch history was synchronized after checking the clean checkout and identical trees.
- The clean committed build recorded `5f24795e8bd6ae8b6ff5bbe9b6c084f70cfed1f3`, `sourceDirty: false`, and source SHA256 `608384f3bebd3c213821a085d3c13b7d4ba1c0427137a4d4a22d0e8f1a559cc1`. Package and soak evidence used the same source hash before commit; their build metadata and execution-host binary hash differ, so they do not establish byte-identical validation of the later build.
- This follow-up changes delivery documentation only. No additional source changes are included after the completed validation.
