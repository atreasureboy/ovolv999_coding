# Cross-module audit repairs implementation plan

> For agentic workers: implement the approved audit repairs in independent ownership groups, using regression-first development and a final independent review.

**Goal:** Repair the eight confirmed integration defects and the two reproduced continuity defects without adding product features.

**Architecture:** Retain AgentService and AgentSessionClient as the session owners. Bind authorization and mutable command context to the current session; normalize model projections and request-specific reasoning settings at existing boundaries. Keep canonical history intact and ensure output transport cannot prevent cancellation cleanup.

**Tech Stack:** TypeScript strict ESM, Node >=22.13.0, Vitest, Windows managed execution host.

**Spec:** The 2026-10-16 audit at baseline 6157d1b, archived locally in .artifacts/audit-2026-10-16/audit.md; the user authorized implementation after reviewing its findings and repair order.

## Constraints

- Preserve existing history, approval evidence, CLI compatibility and protocol validation.
- Do not add code comments, dependencies, paid provider requests or unrelated feature changes.
- Keep the current clean codex/module-refinement checkout and consolidate changes here.
- Unknown usage and opaque reasoning accounting remain explicitly documented qualification items; do not invent provider token precision.
- Each group first adds a regression demonstrating the audited break, runs it red, implements the fix, then runs its affected tests green.

## 1. Session ownership

Files: approvalBroker.ts, engine/approval.ts, engineSession.ts, agentSessionClient.ts, agentService.ts and their focused tests. Coordinate before editing engine.ts, which belongs to model continuity.

- [x] Bind session grants to stable session identity, preserving reuse inside one session and isolating resume/recovery and simultaneously registered sessions sharing a broker.
- [x] Mark a thread as releasing before awaiting engine disposal; reject new work and provide idempotent release/disposal behavior without orphaning events.
- [x] Validate cross-session Write approval and release/start/dispose races with real service/client paths, including failed switching or release.

## 2. Model request contracts

Files: compact.ts, modelRuntime.ts, modelGateway.ts, model/*, engine.ts and focused provider/engine tests.

- [x] Make the compacted projection consumable by Chat, Responses and Anthropic without weakening native message validation or deleting canonical history.
- [x] Give auxiliary requests an explicit reasoning policy compatible with their output budgets, retaining configured reasoning on main requests. Cover summary, critic and reflection call paths.
- [x] On an intentional model switch, rebuild continuation from visible history for the new model; retain fail-closed checks for corrupted state and unsupported protocol changes.
- [x] Verify actual outgoing requests and successful next turns after compaction/model switching; test cancellation and tool-result preservation at these transitions.

## 3. Execution and output lifecycle

Files: cli/exec.ts, managedProcess.ts and focused CLI/managed execution tests.

- [x] Bound and cancel pending JSONL writes on interrupt/output failure, preserving durable outcome and releasing service ownership. Do not truncate ordinary backpressure without termination.
- [x] Resolve relative executable paths against child cwd; test a differing host cwd through managed startup and HookService or MCP.
- [x] Validate termination with a stopped consumer, no leaked signal listeners/leases, normal output delivery, and failed launch resource settlement.

## 4. Command and planning semantics

Files: cli/repl.ts, commands/sessionCommands.ts and corresponding command/lifecycle tests.

- [x] Resolve engine/sessionDir dynamically throughout composite commands so workflow resume followed by configuration or status uses the new session.
- [x] Use model-window history and the current model's input budget for context pressure; preserve separate canonical history counts and search semantics.
- [x] Transfer the actual approved plan to execution while preserving separate planning records and existing cancellation behavior.
- [x] Validate real workflow sequencing and the execution request payload, plus compact/status behavior for different context budgets.

## Review focus

- A shared broker must not leak session grants between concurrent threads, failed switches or recovery forks.
- Disposal must not race release into duplicate lease release or leave an accepted turn without a durable terminal event.
- Model migration must discard only obsolete continuation, not tool pairs, transcript content or legitimate corruption checks.
- Interruption must end blocked output without suppressing the durable turn outcome or leaking a pending write rejection.
- Context displays must remain valid above 100% estimated pressure; plan handoff must include the approved content and avoid accidentally replaying planning tools.

## Final gates

- [x] Review integrated diff independently; fix actionable findings and rerun affected checks.
- [x] Typecheck, lint, full Vitest suite serially with isolated state, production build and package smoke.
- [x] Record exact passed/failed/skipped totals and material limitations in the progress document.
- [x] Commit and push the current branch using the user's existing authorization; verify remote commit identity.

## Verification record

- Implementation commits: `11a08a4` (session/model boundaries), `60ed6a2` (execution/output), `210d327` (commands/planning). The remote branch matched `210d327ff40edb5df17de5222c6240d33102f82b` before this documentation commit.
- Windows x64, Node v24.20.0: 316 test files, 4987 passed, 0 failed, 14 existing skips. Typecheck, full lint and production build passed.
- Actual installed package: 24 cases passed, including 12 offline coding scenarios with their expected positive/negative outcomes. Short local MCP soak: 152 requests, 38 samples, no pending/queued/buffered data after close.
- Final production source SHA256: `c21dfc77ddaff821d1754f1da315dff34d2fde9039e5779a1ccb994a2f28962f`. Full evidence and qualification limits are recorded in `docs/agent-core-progress.md` and the local `.artifacts/audit-repairs-2026-10-16` directory.
- Independent review reproduced and closed the model-switch/session-rebuild combination; execution review found no additional confirmed issue. Windows control signals were delivered through a fixture control channel; forced OS termination, other platforms and real provider qualification remain outside this verification.
