# Architecture correctness implementation plan

> Execute the supplied architecture remediation specification directly, with failure-first behavioral tests and one integration owner for runtime/configuration. User authorization supersedes redundant design approval gates.

Goal: truthful outcomes, preserved worktree data, isolated runs, controlled cancellation, durable memory, and reproducible delivery without replacing public capabilities.

Baseline: bb5ed63c66636d790f6a2cc9707fc2c7d73cd0cd, origin atreasureboy/ovolv999_coding. Work in the user-designated checkout; no push, reset, cleanup of user files, dependency upgrades, or UI redesign.

## Tasks

- [x] P0 worktree safety: capture base/target/artifact identity, retain dirty/conflicted/unaccepted trees, permission-check explicit discard. Real temporary Git regression tests.
- [x] P0 outcomes: additive status and verification contracts; validate Agent and Loop artifacts, propagate failure to CLI/background/UI, retain raw pipe compatibility.
- [x] P0 permissions: ask without a callback stops without side effects; deny has precedence over allow/bypass.
- [x] Run ownership: per-run file state, signal, pending calls, workspace, policy revision and result. Effective configuration throughout; live plan mode; explicit child role.
- [x] Scheduler/lifecycle: bounded read concurrency, conservative write serialization, settle every call, bounded cancellation, quarantine lingering tools, await disposal and module finalization. OS-level/external-process isolation remains outside this implementation.
- [x] MCP/persistence: reuse connections, clean partial initialization, cancel waits, preserve per-turn retrieval; truthful disk writes, JSONL transactions, provenance, original file baselines.
- [x] Model/context: resolve current model budget, refresh modules, budget every engine request/retry, preserve continuation text and tool-result causal groups. Exact auxiliary usage rollup remains incomplete.
- [x] Delivery checks executed: registry/capability inventory, full regression/typecheck/lint/build, package install smoke, independent review. Full tests/lint are not all passing.
- [ ] Resolve the remaining 40 full-suite failures, repository-wide lint, Linux validation and documented external-process/generated-artifact limits before claiming complete release readiness.

## Interfaces and ownership

- Runtime integration owner edits engine.ts, types.ts, module.ts, configuration, scheduling and file-state injection.
- Worktree worker edits worktree.ts and behavioral Git tests; structured binding selects child workspace explicitly.
- Outcome worker owns outcome.ts, verification.ts, agent.ts, loopEngine.ts and CLI adapters. Verification captures commands/definition identity/artifact identity/run identity.
- Persistence worker owns semanticMemory/fileHistory/MCP/memory/reflection implementations and tests.
- TurnResult and ToolResult retain existing fields; new status/verification are optional for compatibility, populated by the runtime.
- Run owns AbortController, file snapshots and pending calls; Engine owns session connections and refuses reentry. Write conflicts are excluded while previous effects are unsettled.

## Review focus

1. A tool ignores cancellation: bounded return must leave the workspace quarantined until real settlement.
2. A child fails verification but supplies confident output: parent/CLI/Loop must stay unsuccessful.
3. Plan mode changes midway through a tool batch: current policy governs the very next call.
4. A worktree target or artifact changes after acceptance: merge must retain data and reject stale evidence.
5. Disk/connection initialization fails halfway: preserve last valid state and clean acquired resources.

## Evidence ledger

- Baseline remote/HEAD/clean status verified before changes.
- Frozen pnpm install initially blocked by sandbox network; elevated download succeeded but pnpm 11 rejected unapproved esbuild build script. Dependencies are present. Exact errors retained under .artifacts/architecture.
- Standard baseline checks initially blocked by pnpm's automatic install validation; direct local tool entrypoints are being run without bypassing test failures.
