# Module Refinement Implementation Plan

> **For agentic workers:** Use domain-scoped parallel implementers and root integration. Steps use checkbox syntax for tracking.

**Goal:** Simplify implementation and make module ownership explicit while preserving the coding agent's active contracts.

**Architecture:** Keep public entry modules compatible. Extract cohesive responsibilities, consolidate duplicate implementations, and remove proven shadowed or unreachable code. Root owns engine and CLI integration; each parallel implementer owns disjoint file domains.

**Tech Stack:** TypeScript strict ESM, Node >=22.13.0, existing pnpm/Vitest/ESLint tooling.

**Spec:** `docs/superpowers/specs/2026-10-03-module-refinement-design.md`.

## Global constraints

- No new dependencies or code comments.
- Retain session v2, RunStore v1 and workspace lease v1 compatibility.
- Retain approval fail-closed, verified outcome, physical process settlement and workspace quarantine contracts.
- Keep existing public imports and effective command order.
- New tests live under `tests/`, mirroring source domains.
- Reuse the clean current checkout on a dedicated `codex/` branch; no unrelated worktrees need cleanup.

## Review focus

- Plan mode changes within a turn must affect both advertised and executable tools.
- Provider stream-option fallback must omit tool choice when the tool list is empty and record usage once.
- Reordered module finalizers must never make stale artifact acceptance appear completed.
- Commands after an Ink turn must operate on the latest history, including clear and resume.
- File backups, stale-read checks, abort checks and cache refresh must retain their execution order.

## Task 1: Engine boundaries (root)

Files: `src/core/engine.ts`, new `src/core/engine/{observer,toolPolicy,toolResults,responseStream,acceptance}.ts`, affected engine contract tests.

Interfaces: keep `ExecutionEngine`, `partitionToolCalls`, `enforceAggregateToolResultBudget` exports. Core-owned `EngineObserver` describes only engine events. Pure policy helpers share filtering for definition generation and actual dispatch. Stream consumer returns assistant text, finish reason, ordered calls and usage. Acceptance owns verification/finalizers/journal completion in their existing order.

- [x] Read execution, cancellation and acceptance paths and run the baseline suite.
- [x] Pin empty-tool request fallback and preserve dynamic policy tests.
- [x] Extract cohesive responsibilities and remove unreachable duplicate branches.
- [x] Run engine, runtime, permission, outcome, thinking and artifact suites; inspect diff.

## Task 2: CLI boundaries (root)

Files: `bin/ovogogogo.ts`, new `src/cli/{args,environment,paths,help,sessions}.ts`, CLI tests.

Interfaces: preserve entrypoint helper exports, flags, help text, session safety errors and early dispatch before API-key resolution. Parser throws a typed argument error; the entry composition owns error display and exit. Environment loading has an explicit call site.

- [x] Preserve existing CLI behavior with its process-level tests.
- [x] Extract parsing/environment/path/help/session responsibilities; unify repeated subcommand dispatch.
- [x] Remove redundant private argument implementations only after call-site verification.
- [x] Run CLI and pipe suites and installed CLI checks.

## Task 3: Commands and Ink state (commands implementer)

Files: `src/commands/builtin.ts`, new `src/commands/*Commands.ts`, `src/ui/ink/{runInkRepl,store,replController}.ts`, command/Ink tests.

Interfaces: explicit command arrays plus one registration assembly; keep worker-manager exports and final registry order. Controller owns current history and constructs current slash context.

- [x] Characterize registry order and effective duplicate handlers.
- [x] Replace monolithic registration with cohesive groups; delete overwritten `/export` and `/plugins` implementations.
- [x] Reproduce stale slash history; fix through controller state ownership.
- [x] Simplify store publication without weakening overlay lifecycle; run relevant tests and lint.

## Task 4: Tool and skill internals (tools implementer)

Files: `src/tools/{fileRead,fileWrite,fileEdit,bash,tasks}.ts`, new focused file/formatting/output helpers, `src/skills/extractor.ts`, relevant tests.

Interfaces: unchanged `Tool` and `ToolContext`; helpers own path/backup/atomic write stages, bounded byte collection, formatter execution and diff rendering. Task lookup has one rendering path. Skill metadata has one typed mapping.

- [x] Use existing atomic/containment/output tests and characterize direct task behavior.
- [x] Consolidate duplicated stages preserving catch and abort placement.
- [x] Extract formatting/output responsibility and simplify task/skill branches.
- [x] Run relevant suites, lint and typecheck.

## Task 5: Provider/configuration/protocol boundaries (infrastructure implementer)

Files: `src/core/providers.ts`, new `src/core/providers/*.ts`, `src/config/settings.ts`, new `src/config/settings/*.ts`, `src/config/projectContext.ts`, `src/integrations/acp.ts`, new `src/integrations/acp/*.ts`, corresponding tests.

Interfaces: existing exports and ordered provider matching; fixed hook-name set, append during layering versus replace during patches; bounded ACP reader with start/stop listener ownership; single method traits map for initialization/exclusivity.

- [x] Pin provider detection precedence and configuration merge distinctions.
- [x] Extract metadata/normalization/framing and simplify repeated branches.
- [x] Verify multibyte framing, restart, initialization and busy ownership.
- [x] Run domain suites, lint and typecheck. Leave gateway/admission accounting intact absent a demonstrated simplification.

## Task 6: Remaining domains and final integration (root plus reassigned implementers)

- [x] Examine persistence/runtime, modules/memory, remaining UI and utilities for concrete duplication and dead code; refine independently where justified.
- [x] Record module ownership and examined-but-unchanged boundaries in repository documentation.
- [x] Obtain an independent whole-diff review; fix reproduced regressions.
- [x] Run full typecheck, lint, tests, build and installed-package acceptance on frozen source.
- [x] Save reviewable domain commits and report actual scope, baseline comparison and remaining limitations.
