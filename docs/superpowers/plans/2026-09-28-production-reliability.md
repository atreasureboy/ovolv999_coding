# Production Reliability Implementation Plan

> Implement with the executing-plans / subagent-driven-development workflows, with one integration owner for Run, Outcome and Workspace interfaces.

**Goal:** Make the existing trusted-local CLI and single-host workers observable, bounded and recoverable without weakening prior safety guarantees.

**Architecture:** Keep the existing engine and adapters. Add small durable owner/operation records at existing side-effect boundaries; coordinate independent processes through verified local ownership, preserve unknown outcomes, and refuse unsupported isolation. Keep diagnostic events separate from authoritative receipts.

**Tech Stack:** Existing strict TypeScript/ESM, Node >=22.13, pnpm lockfile, Vitest. No database/framework migration.

**Spec:** User-provided `C:/Users/zhhqzs/Desktop/chatgpt临时文件/ovocoding/codex_production_prompt.md` and `production_audit.md`, targeting commit `183cb2b2a8be3ba47fcc519cb554559dae1ba526`.

## Constraints

- Retain public tools/modules, trusted-local explicit auto/bypass, raw text-only pipe, honest outcomes, worktree preservation, and existing JSONL layouts.
- No push, npm publication, public deployment, credential changes, force reset or user worktree cleanup.
- Local regular filesystems only; do not claim NFS/distributed guarantees. Linux and isolated execution must have actual evidence or explicit unsupported status.
- Root integrates engine.ts/types.ts/runContext.ts and shared protocols. Parallel workers own disjoint files and communicate interface changes before integration.
- Every defect uses real-module failing behavior tests, a minimal repair, and relevant passing integration checks. No fabricated green checks or blanket skipping.

## Execution batches

- [ ] Baseline: remote/HEAD/clean state, frozen install, typecheck, full lint/tests and build; record fresh logs under `.artifacts/production/`.
- [ ] PROD-01/03 storage owner: sessionManager unique exclusive IDs, revision/owner conflicts, legacy and multimodal round trips; persistenceLock crash recovery, verified owner and nonblocking contention API. Real subprocess collision/kill tests.
- [ ] PROD-02/07 process owner: backgroundSession + CLI start/stop physical confirmation and identity, atomic metadata, range logs/EOF/backpressure; daemon native socket and bounded shutdown. Owned process-tree tests.
- [ ] PROD-04/12 release owner: committed packed CLI fixtures/scripts, prepack clean build and build identity, OS/Node CI contract, README capability corrections, release gates that fail on real errors.
- [ ] PROD-05 integration: persistent workspace/commonGitDir lease owner and fencing; cancellation queue, dead-owner recovery boundary and durable unknown-operation quarantine. Two actual processes must never overlap writes.
- [ ] PROD-06 integration: versioned RunStore intent/receipt at Engine tool boundary, owner/workspace/verification identity, unknown recovery classification, refuse blind replay. Kill-after-effect-before-receipt fixture.
- [ ] PROD-10 integration: ACP file handlers disabled without explicit service; initialized/schema/capability/size limits; execution profile and backend fail-closed for unavailable isolation, consistent subprocess environment policy.
- [ ] PROD-07 integration: MCP frame/pending/output caps, bounded outbound writes with drain, peer death/overflow cleanup; sustained local subprocess probes.
- [ ] PROD-08 integration: cancellable streaming artifact hashes with byte/file/deadline budgets and measured counters; explicit verification check kinds/scopes, no false task-acceptance claim.
- [ ] PROD-09 integration: shared provider admission, bounded classified retries/circuit state and cancellation, stream lifecycle and usage reservation/settlement; fault-injecting local provider tests.
- [ ] PROD-11 integration: versioned correlated/redacted diagnostic events and truthful persistence health, recovery/status diagnostics and concise operator runbook; intent failure must stop effects.
- [ ] Final: independently review real entrypoints, run all checks and packed-install smoke, record failures/limits, make small local commits with documented evidence; no push.

## Review focus

- A dead process's PID has been reused: never treat another live process as its owner or terminate it.
- A tool wrote before its receipt: retain unknown and block automatic replay even after a restart.
- A cancelled request still streams or writes: logical timeout does not release physical ownership.
- A slow/oversized peer: keep buffer, queue and output bounds; surface overflow without silent acceptance.
- Runtime logs mutate during verification: explicit runtime exclusions remain inherited while real deliverables remain covered.
