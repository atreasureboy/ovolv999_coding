# ARTEX first-batch whole-change independent review

**Ready to merge / deliver? With fixes.** One Important finding remains at the compatibility-receipt publication boundary. No Critical or Minor findings are reported. The existing broad green acceptance is substantial, but does not cover the independently reproduced outside-workspace overwrite below.

**Spec compliance:** Needs fixes. **Whole-change quality:** Needs fixes.

## Scope and method

- Authoritative range: `ecddc30f281befd0b9de75e8f9e38eabaed9838a..6a49eaf42f9c2139e547ab8b869cd02c53f2e110`; current HEAD was checked and matches the supplied head.
- Read `final-review-instructions.md`, approved design section 6, the complete implementation plan, progress and its Rulings/deferred observation, `delivery-evidence-input.md`, `task-6-report.md`, and the earlier Task 5 receipt-link analysis. The durable decision record preserves the stated rationale and cost of the scope decisions.
- Read the complete 8,077-line, 67-file supplied package `final-review-1792725840635.md` in bounded passes. Truncated initial documentation output was reread in smaller slices. No Git diff was regenerated.
- Reviewed the changed architecture across structured host causes, service/client events, durable attempt transitions, shared artifact policy, independent verification, bounded feedback, CLI resume selection, and background compatibility. Unchanged dependencies were inspected only for named risks: canonical path identity, operation-recovery gating, and failed Agent receipt semantics.
- No implementation, test-file, index, HEAD, branch or dependency change; no helpers or subagents. One isolated actual-controller probe was executed for the concrete receipt-link doubt. Its own disposable fixture was removed only after checking its resolved containment beneath this plan scratch. This report is the retained review artifact.

## Strengths

- Durable accounting is conservative at the right boundary: prepare consumes an iteration before submission, the phase machine rejects incomplete recovery, and there is no refund or replay API. The archive is written before authoritative state and is not adopted as recovery authority.
- The store checks lease ownership, state content as well as revision, bounded whitelisted records, private evidence files, digest/byte references, and successful nonempty zero-exit receipts. Evidence or publication failure cannot be silently downgraded into a successful checkpoint.
- Service terminal events and independent Loop acceptance remain separate facts. Completion requires Loop-source evidence for the current workspace, artifact and definition; service completion alone does not complete the task.
- The cross-task identity fixes are coherent: framed GOAL/ACCEPTANCE hashing fails closed for the earlier ambiguous format; service turn/sequence/history identity is checked; changed completed artifacts are revalidated under workspace ownership without consuming another model turn.
- The same frozen policy reaches engine, verification, controller and canonical same-workspace Agent scans. The exclusions distinguish actual runtime writer formats from user reports, tracked/untracked source and task files, with Windows case handling that preserves encoded owner bytes.
- Feedback is projected into a bounded model window while canonical history is retained. The implementation sanitizes complete values before truncation, fingerprints before truncation, and refreshes configured credentials while remembering earlier task-local keys.
- The new CLI acceptance uses the actual compiled entry, request payloads, durable states, real child deaths and the genuine production background worker. The tests explicitly distinguish physical cleanup, received readiness, durable service outcome and task acceptance.

## Issues

### Critical

None established.

### Important F1 — Compatibility receipt publication can overwrite unrelated files and still commit completed

**Locations:** `src/core/autonomy/loopController.ts:143` and `src/core/autonomy/loopController.ts:146`; the relevant exclusion is `src/core/artifactPolicy.ts:157`.

The controller publishes DONE.flag and OUTCOME.json with raw truncating `writeFileSync` calls. Workspace/store ownership assertions do not validate either receipt leaf or prevent following a link. In particular, a preexisting hardlink is a regular file and its canonical pathname is still the managed receipt pathname, so the artifact policy excludes it. Writing the receipt truncates and overwrites every other name of that file, including an unrelated file outside the scanned workspace. The final artifact comparison does not observe that outside target, and the authoritative checkpoint can then become completed.

This requires only static preexisting filesystem links; it does not require a hostile process racing the locks or rewriting trusted ledger files. A symlink may also follow the raw write, but a privileged file-symlink probe was not needed or claimed. The independently executed hardlink case proves the user-visible data-loss behavior on this Windows host.

**Independent bounded proof:** Executed the existing built `runLoop`, actual `AgentSessionClient` and actual engine against a loopback HTTP provider. The isolated workspace contained a valid goal, executable `node check.cjs` acceptance, and a passing check. Before running, DONE.flag and OUTCOME.json were hardlinked to two sentinel text files in a sibling directory outside that workspace. No product behavior was mocked, and no source/test file was edited. The command exited 0 and printed:

```json
{
  "status": "completed",
  "requests": 1,
  "iterations": 1,
  "doneTargetOverwritten": true,
  "outcomeTargetOverwritten": true,
  "targetsOutsideWorkspace": true,
  "nlink": 2,
  "phase": "checkpointed",
  "authoritativeDecision": {
    "action": "stop",
    "status": "completed",
    "detail": "Current independent Loop acceptance passed"
  }
}
```

The target files contained the controller's receipt JSON after the run, with the current taskId. The built controller's framed goal hash and receipt-write locations were checked against the reviewed source before executing the probe. This proves actual controller/service behavior, rather than merely showing that an isolated filesystem write can follow a link. It is not a second full CLI/package acceptance run.

**Why this is in the whole-change gate:** The supplied base already had raw compatibility writes; this is explicitly not presented as a newly introduced Task 5-only regression. The approved batch now owns guarded publication of these files as part of a validated durable checkpoint. A reasonable user does not expect publishing a controller marker to destroy unrelated data and then report accepted completion. The whole-change contract requires judging that changed-flow boundary on its actual effect, so the preexisting provenance does not set this confirmed behavior aside.

**Correction:** Publish compatibility receipts through a narrow safe staged-write/rename path, with validated parent/leaf handling and the existing store/workspace guards before publication. Do not truncate a preexisting receipt target through a following open. Reject or safely replace linked/nonprivate leaves without modifying their targets; checking `nlink`/symlink status alone before a raw open is insufficient against a pathname replacement race. Keep authoritative state last and preserve the existing uncertain-publication recovery behavior.

The controller also identified the existing `src/core/atomicWrite.ts` as a candidate primitive. A bounded independent read confirmed that its editor-style implementation deliberately resolves and follows symlinks (`realTarget = await realpath(target)`); merely substituting that helper would leave the symlink variant unresolved. This correction needs receipt-specific non-following publication semantics.

Add focused regressions using real filesystem hardlinks for both DONE and OUTCOME, including a target outside the scanned workspace, and verify the targets remain byte-identical and no unsafe completed authority is published. Cover failure/continue OUTCOME publication as well as successful DONE publication; execute file-symlink coverage where the platform permits it. These are one publication-boundary defect, not two separate findings.

### Minor

None established.

## Cross-task checks and dispositions

| Boundary | Review result |
| --- | --- |
| Host failure classification to continuation | Typed permission/approval/budget/recovery causes are produced at actual branches and retained through service persistence. Cancellation/interruption precede retry; only explicit acceptance_failed may continue. Unclassified model/tool text does not create retry authority. |
| Attempt accounting to actual dispatch | prepare precedes runTurn; started/finished lifecycle callbacks bind dispatch/settle before rendering. Callback failures stop the controller, and incomplete phases remain recovery obligations. Start is correctly not treated as an execution barrier. |
| Current service identity to resume | Snapshot checks thread, active turn, approval/recovery state, terminal turn/sequence and both saved/current history revisions. Missing or conflicting ledgers do not create a replacement task. |
| Independent acceptance to durable completion | Evidence source and strict successful command receipts are checked by both decision/store layers. Final scans and definition checks guard authoritative publication; F1 is the remaining receipt-path safety gap. |
| Artifact policy to stagnation | Runtime/state churn is excluded precisely, real source and user reports are included, and fingerprints preserve full pre-truncation diagnostics. Durable stagnation survives restart. |
| Parent Loop config to Agent/session boundaries | Parent frozen acceptance is cleared for children; only canonical same-workspace children keep the policy. Actual session switches clear session-bound fields. |
| Failed child acceptance to next Loop turn | Considered loss of child command receipts at parent acceptance. The actual failed mutating Agent path receives unknown-effects operation receipts and the controller's unchanged recovery dependency blocks before retry. No concrete current production path bypassing that gate was established; see Declined to judge. |
| CLI and background compatibility | Explicit-limit provenance, newest-session selection before ledger checks, actual client binding/cancellation/hooks, bounded service deadline configuration, asynchronous background outcome persistence and received-ready handling are coherent with the approved rulings and tests. |
| Delivery documentation | Actual counts and npm refusal are accurately distinguished. Pending review status/unchecked plan boxes are bookkeeping awaiting this gate, not claimed final approval. No finding is raised for that pending bookkeeping. |

## Verification evidence and limits

Existing verification was inspected and not rerun. Counts overlap and are not summed.

| Evidence | Result used |
| --- | --- |
| `task-6-suite-final.log` | Direct log summary: 330 files passed; 5354 tests passed / 14 skipped, 5368 total; 382.82 seconds. Execution report records exit 0. |
| `task-6-report.md`, `task-6-review-report.md` | Final expanded CLI/service/background gate: 9 files / 203 tests passed. Earlier RED/diagnostic failures and correction rationale are retained. |
| `task-6-typecheck-final.log` and implementation report | No diagnostics; fresh typecheck exit 0 recorded by the execution report. Empty/no-diagnostic output alone is not a newly executed reviewer exit-code check. |
| `task-6-build-final.log` | Built identity/source hash matches the recorded final source: `9e9654ffe897e64ddda62392e7870eb13d94c9f7037847c2e55d3df94482e76e`; build exit 0 is recorded by the execution report. Precommit base3fadf55/sourceDirty:true is disclosed accurately. |
| `task-6-package-npm.log` | Exact npm invocation is refused before packing by the existing pinned-runner contract; exit 1 is documented, not counted as a successful package run. |
| `task-6-package-final.log`, `task-6-package-receipt.json` | Supported pnpm invocation passed 24 scenarios; receipt passed:true, with matching source hash and tarball SHA256 `087c3eeeeaad48f40a52c9e5c12c62408390e879f91208c73e5e23de2465d1cd`. |
| Fresh isolated receipt-link probe | Unrestricted local execution exited 0 and demonstrated F1 through actual built controller/client/engine code, one loopback request, one consumed iteration and completed authority. Only disposable sentinel/fixture files were changed. |

The probe used unrestricted local process access from the outset, respecting the previously demonstrated Windows sandbox user/process-query limitation. No suites, typecheck, build or package smoke were duplicated. A read-only Git status check emitted the host's global-ignore permission warning and no porcelain entries; HEAD remained the supplied commit. No remote operation or publication occurred.

## Declined to judge

Every considered behavior set aside from a new actionable finding is listed explicitly:

- Automatic takeover/replay at arbitrary instruction boundaries, background Loop, cron/DAG/planner/knowledge-graph work, and a second task-wide token/cost account: expressly outside approved first-batch scope; incomplete attempts conservatively stop.
- Whole-machine power-loss durability and an unrestricted hostile process rewriting all trusted records or filesystem roots: no such guarantee is made by this batch; the confirmed static-hardlink defect F1 does not depend on either assumption.
- A separately executed privileged file-symlink case and new POSIX process/executable behavior: this host lacks file-symlink privilege and the available execution evidence is Windows-only. F1 is established independently with working hardlinks; its symlink variant is a recorded limit, not an invented successful test.
- Native Windows console Ctrl+C delivery and a literal ten-minute CLI expiry wait: the existing evidence enters the real signal handler through test-only IPC and uses short injected service deadlines; constants/wiring were reviewed without claiming those additional native delivery/wall-time experiments.
- Improved repair quality from live external models: scripted local providers prove payloads, decisions and persistence behavior, not a model-quality improvement rate.
- Residual compatibility DONE/OUTCOME text before a later authoritative state failure: the plan explicitly makes these files non-authoritative and state/evidence checks prevent their use as completion authority. The different target-overwrite behavior is retained as F1.
- Service completed status while independent Loop acceptance fails: intentional separation required by the approved design and asserted by real CLI tests; not a false task success by itself.
- Lost child acceptance-command projection after a failed mutating Agent: the bounded dependency check confirmed the existing operation recorder marks failed mutating Agent effects unknown, and actual controller recovery gates stop before continuation. Extending post-failure child scheduling or weakening reconciliation would contradict the explicit ruling; no concrete current bypass was established in this review.
- Comprehensive shell-expression executable discovery: the approved narrow preflight handles simple bare executable/builtin names; arbitrary shell expressions retain host semantics. No full shell-parser capability is claimed.
- Rejecting the plan's exact npm package spelling while supported pnpm smoke passes: an explicit scope ruling preserves the repository's pinned-runner contract and reports both results; changing package-manager policy is outside this batch.
- Pending plan checkbox/status updates and final remote integration/publication decisions: the controller explicitly reserves bookkeeping until this independent gate; no final approval or new publication authorization is inferred.

## Recommendation and assessment

Fix F1 with the smallest receipt-publication change and focused real-link regression evidence, then obtain scoped independent re-review. Preserve the already established full-suite/build/package evidence; broaden verification only as justified by that fix's actual affected surface.

**Ready to merge / deliver: With fixes.** The core durable controller, stop semantics, feedback projection and real CLI integration are well supported. The reproduced ability to overwrite unrelated files and still publish completed is an Important unresolved safety defect at a boundary this batch actively changes, so the current head should not receive final readiness approval.
