# ARTEX F1 — sole scoped independent re-review

Review date: **2026-10-25, Asia/Shanghai**. Implementation/test evidence retains its original 2026-10-23 dates.

Range: `6a49eaf42f9c2139e547ab8b869cd02c53f2e110..76653f1eb9e53ab8d69dd22f1c807fc96be29e67`.

## 1. Finding verdict F1: ADDRESSED

The original Important F1 was reproduced actual-controller data loss: raw DONE.flag and OUTCOME.json writes followed static hardlinks to unrelated sibling files outside the scanned workspace, and the controller still published a completed authoritative checkpoint. The fix closes that path and supplies meaningful real-filesystem regression coverage.

Exact implementation evidence:

- `src/core/autonomy/loopController.ts:70` constructs the receipt publisher from the existing frozen canonical `policy.loopDir`. This preserves legitimate workspace-junction aliases while anchoring the publisher to the intended real directory.
- `src/core/autonomy/receiptPublisher.ts:16` validates the receipt directory as a real directory with matching lexical/canonical identity and the original device/inode. `receiptPublisher.ts:23` permits absent leaves or private regular files only; symlinks, non-file leaves and `nlink !== 1` are rejected. Static preexisting hardlinks therefore fail before any truncating write to their target.
- `receiptPublisher.ts:38` calls the existing ownership guard before staging. `receiptPublisher.ts:41` creates a unique same-directory file with exclusive `wx`; bytes are written through its descriptor, synchronized and closed at `receiptPublisher.ts:47` and `receiptPublisher.ts:51`. No following/truncating open is performed on the destination receipt.
- `receiptPublisher.ts:54` calls the ownership guard again immediately before directory, destination-leaf and staged-inode checks. `receiptPublisher.ts:58` then renames the staged file onto the destination and validates the published inode. A hardlink introduced after leaf validation is replaced by the rename; its outside target is not truncated.
- `receiptPublisher.ts:62` retains the underlying cause in a typed session `recovery_required` error. Cleanup at `receiptPublisher.ts:67` only removes a still-identifiable staged private file under the unchanged parent. Replaced-parent/stage uncertainty is retained rather than deleting a different object.
- Both actual writes consume this helper at `loopController.ts:145` and `loopController.ts:147`. OUTCOME uses it for completion, terminal failure, limit termination and continuation; this is not a DONE-only repair.
- The existing artifact/definition recheck remains at `loopController.ts:149`, followed by the final ownership guard and authoritative checkpoint/revalidation at `loopController.ts:152`. A receipt failure occurs before that state commit and before any next iteration. No artifact exclusion, editor atomicWrite semantics, attempt accounting or replay policy changed.

Regression evidence matches the original effect rather than merely asserting a new helper call:

- `tests/integrations/loopController.test.ts:46` exercises five real outside-workspace hardlinks: DONE completion, OUTCOME completion, OUTCOME limit after failed acceptance, OUTCOME genuine failed service terminal from HTTP 400, and OUTCOME retry-eligible acceptance failure. It verifies exact binary sentinel preservation, blocked/recovery_required, settled state with no checkpoint, one provider request, and refusal to resume/replay with the consumed iteration retained. The failed-provider case additionally asserts the actual saved service terminal is failed.
- `tests/core/autonomy/receiptPublisher.test.ts:70` installs a real destination hardlink inside the actual rename wrapper, after validation, then verifies successful receipt replacement and unchanged outside target bytes. This establishes that the fix does not rely solely on a pre-open link check.
- Helper regressions at `receiptPublisher.test.ts:31`, `receiptPublisher.test.ts:40`, `receiptPublisher.test.ts:88` and `receiptPublisher.test.ts:105` cover ownership loss, fsync/rename failures, stage replacement, and parent-directory/junction replacement. The wrappers preserve real filesystem behavior except for the named injection boundary.
- `tests/integrations/loopController.test.ts:339` checks both controller publication guard-loss paths: no corresponding published receipt, no ordinary staged residue, settled/no-checkpoint state and no further request.
- `tests/integrations/loopController.test.ts:27` proves actual successful receipt/checkpoint publication through an existing junction workspace alias. The final canonical binding fixes the same-wave alias regression without weakening the publisher's post-freeze identity checks.

The static-hardlink loss demonstrated by the original review is therefore addressed. Actual privileged file-symlink execution remains limited as stated below; the source rejects such leaves structurally, and no successful file-symlink execution is claimed.

## 2. New breakage in the fix diff

**None established.** No new Critical, Important or Minor finding is reported.

The production diff is confined to the receipt helper and its two controller call sites plus canonical initialization. Ordinary private-file publication, alias compatibility, authority-last ordering, conservative recovery, and cleanup of ordinary staged files are supported by the read code and focused regressions. The existing editor helper was not repurposed, and new temporary paths are removed before the controller's subsequent artifact scan during successful publication. Retained uncertain residue occurs only on the already-blocked recovery path.

## 3. Out-of-scope / non-blocking observations

- The final-source parallel full run has three unresolved original 5000ms timeouts in `runtimeFixes.test.ts` and `runtime3.test.ts`. The complete serial full run passes, but that does not erase the red parallel result or establish its precise cause. These unchanged runtime files are outside this receipt fix; no causal link to this fix or new product defect was established. Preserve this as an explicit verification limitation, not a claim that every prescribed command is green.
- Both real file-symlink creation attempts returned EPERM and skipped. Real hardlinks and junctions executed successfully; neither substitutes for privileged file-symlink coverage. No new second-platform or privileged execution result is inferred.
- Compatibility DONE may exist if a later OUTCOME or authoritative-state publication fails. This is the existing explicitly non-authoritative marker contract; the settled ledger/recovery checks prevent accepted completion or replay from those marker bytes alone.
- Defeating an unrestricted hostile process replacing trusted filesystem roots/stages/ledgers at arbitrary syscall boundaries, whole-machine power-loss durability, and directory-fsync guarantees are not claimed by this scoped correction. The original static-link case does not require those stronger assumptions and is fixed.
- The earlier whole-change review and all its Declined-to-judge dispositions remain preserved; this review does not reopen the six completed tasks or authorize remote integration/publication. Pending final bookkeeping is not mistaken for claimed approval.

## 4. Checks, evidence and limitations

Read `final-scoped-review-instructions.md`, original F1 in `final-review-report.md`, the complete `final-fix-report.md`, and the complete supplied 667-line six-file package `final-fix-review-1792769118737.md` in bounded passes. A truncated documentation slice was reread. Applied the requesting-code-review/code-reviewer contract. Exact source/test locations were checked with read-only file inspection; no Git diff was regenerated and no broad review was restarted.

Existing actual logs/receipt were checked directly:

| Evidence | Observed result / interpretation |
| --- | --- |
| `final-fix-red-complete.log` | Five genuine outside-byte hardlink failures against the original controller; 49 skips including permission/filtered cases. Failure location is the exact binary byte-preservation assertion. |
| `final-fix-alias-red.log` | Actual alias regression: blocked at iteration 0 with Unsafe Loop receipt directory. It predates the final canonical initialization. |
| `final-fix-alias-green.log` | Eight controller cases passed; the helper file was filtered/skipped. This is not represented as a helper-suite pass. |
| `final-fix-focused-canonical-final.log` | Final unfiltered six-file gate: 108 passed / 2 skipped, 110 total, 45.02 seconds. Implementation report records exit 0. |
| `final-fix-typecheck-canonical-final.log` | Empty/no diagnostics; final typecheck exit 0 and 5.88 seconds are recorded by the implementation report. Empty output alone is not a newly observed reviewer process exit code. |
| `final-fix-suite-canonical-final.log` | Final-source parallel full: 329 files passed / 2 failed; 5372 passed / 3 failed / 16 skipped, 5391 total, 415.33 seconds. Actual failure blocks show the three unchanged 5000ms test deadlines. This run is red. |
| `final-fix-runtime-serial.log` | Named serial diagnosis only: 2 files / 29 tests passed, 19.97 seconds. It is not treated as the full-suite result. |
| `final-fix-suite-serial-final.log` | Complete final-source serial full: all 331 files passed; 5375 passed / 16 skipped, 5391 total, 738.45 seconds. Implementation report records exit 0. The earlier pre-alias green full result is superseded and was not used as the final-source gate. |
| `final-fix-symlink-skips.log` | Both DONE and OUTCOME explicitly show File symlink unavailable: EPERM. All 55 selected-file cases are skipped: 2 permission skips and 53 filtered. This log proves the permission limitation, not passing file-symlink behavior. |
| `final-fix-build-final.log` | Fresh built source SHA256 `4b5ad6400ab8fc25cbbbf2a1cb6b54121e82e3c90bb5d0096e21ecc3616411ec`; precommit base6a49eaf/sourceDirty:true disclosed. Build exit 0 is recorded in the implementation report. |
| `final-fix-package-final.log`, `final-fix-package-receipt.json` | Supported pinned package smoke passed 24 scenarios; receipt passed:true, 93.430 seconds, with the same source hash and tarball SHA256 `362f7475d87d04a79aaf7fe43a262f69287e9b08c26da1f0281b8bae26255185`. Packed identity accurately records its own prepack timestamp/native binary hash and precommit dirty source identity. |

Counts overlap and were not summed. The unchanged npm-wrapper refusal is not claimed to pass; it was not rerun in this wave. No test timeout was raised in the supplied fix diff. The two-file serial diagnosis and complete serial gate do not prove a particular explanation for the parallel timeouts.

This reviewer executed only read-only inspection/status commands and wrote this report. No tests, probes, typecheck, builds, package runs, source/test/index/HEAD/branch mutations, helpers/subagents or publication were performed during this scoped re-review. No additional probe was necessary: the concrete original risk, late destination replacement, state-last ordering and alias doubt are answered by source plus existing real regression evidence. HEAD was checked as `76653f1eb9e53ab8d69dd22f1c807fc96be29e67`; Git status returned no porcelain entries and emitted the known host global-ignore permission warning.

## 5. Verdict

**All findings addressed and no new Critical/Important breakage established. F1: ADDRESSED.** The sole fix is approved within this scoped re-review; there are no remaining actionable findings from the completed whole-change review and this fix review.

Retain the unresolved parallel full-suite timeouts and the two actual EPERM file-symlink skips in final delivery evidence. This approval does not turn either limitation into a passing verification claim and does not authorize publication.
