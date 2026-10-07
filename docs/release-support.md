# Release support and rollback

## Supported target and evidence boundary

This candidate targets trusted local users on a single Windows or Linux host, with Node >=22.13.0 and local filesystem storage. CI checks Node 22.13.0, latest 22.x, and 24.x on Windows and Linux. Other Node majors and operating systems are not release-tested targets. A configured matrix is not evidence that its jobs have passed: retain each actual job result. Local Windows results do not establish Linux support verification.

NFS, SMB, cross-host shared storage, hostile in-process extensions, and public multi-tenant hosting are outside the contract. Isolated-worker requests fail closed until a real independently constrained backend is available and tested. Trusted-local Bash, MCP, plugins, and verification commands can execute user-authorized local code; a worktree or worker thread is not an OS security boundary.

Windows does not implement POSIX executable permission bits. File writes preserve the writable/read-only mapping exposed by Node; file-history rewind checks restoration of a read-only backup. Windows file-symlink tests run only when a real creation probe succeeds. A denied creation privilege is reported as a capability skip; junction write-through and junction-to-directory rejection remain covered on Windows. Enable Developer Mode or provide symlink rights to run the file-symlink matrix. No skip replaces a reproduced product failure.

Budget daily, weekly, and monthly periods use UTC. Weekly periods start Monday at 00:00 UTC. Old weekly usage remains on disk, but a prior local-time-derived weekly key can refer to a different date; review existing weekly usage when updating during an active period.

## Reproducible release gate

Use the pinned package manager from `package.json` in a clean checkout:

```sh
pnpm run release:gate
```

The gate runs frozen install, typecheck, full lint, all tests with four workers, a clean build, packing, frozen installation into a new directory, installed command smoke, and the short soak. It stops on any failure. Lint rules and existing test requirements remain active. Remote branch protection should require every matrix job; repository administrators must configure it separately. Nothing in these scripts pushes, publishes, or changes credentials.

For local diagnosis after frozen install:

```sh
pnpm run build
pnpm run test:package
pnpm run soak:short
```

`build` deletes only the repository's `dist` directory before compiling and removes partial output on failure. `prepack` invokes this clean build even when packing outside the release gate. The package contains runtime JS/declarations, build identity, license, README, changelog, and this support guide. The smoke audits the packed tarball file list for unexpected source, tests, environment files, and credential files, and rejects development-tool leakage. Runtime dependency versions are projected from the repository lockfile into the isolated consumer lockfile; install uses --frozen-lockfile with dependency scripts disabled. Registry metadata may be read for package-manager supply-chain checks; no dependency versions are upgraded.

Windows x64 builds additionally compile the execution host with the installed .NET Framework C# compiler and pack its executable and version/hash manifest under `dist/native/execution-host/bin`. Native source and build scripts contribute to the source fingerprint. The host launches a suspended process, assigns it to its own kill-on-close Job Object, and then resumes it. This owns the process tree; it does not isolate filesystem or network access. A missing or mismatched helper refuses execution. IPC coordinators retain their observed-only contract. Cross-platform builds are separate candidates; a Linux-built package does not qualify Windows execution.

`ovolv999 --version` reports package version, source SHA, and a dirty marker. `dist/build-info.json` additionally records a SHA256 of build input paths and content, build time, and build Node version. The tarball hash is in `.artifacts/production/release-package-smoke.json`. Dirty candidates are useful for local diagnosis but are rejected by the release gate.

The installed smoke uses a loopback-only provider and fixture files. It exercises help/version without an API key, the actual installed command shim, raw pipe without tools, single task, stdin task, resume, ask denial, failing verification, successful read/edit/verification, legacy-session migration, future-version refusal without overwrite, ACP stdio capability negotiation with disabled file handlers, runtime recovery status, and physical shutdown of a fixture parent/child process tree. It does not contact a paid model or demonstrate compatibility with every external editor/MCP server.

The package gate also runs the installed CLI against 12 disposable Git repositories using deterministic provider fixtures. `pnpm run eval:offline` runs the same baseline against the local build; `--cli-path` selects a built or installed entry and `--output` must name an empty evidence directory. Ten coding tasks must pass independent acceptance. Cancellation/recovery and external-conflict cases must produce their declared negative outcome and preserve the expected state. `fixturePassed` measures harness correctness; it is separate from `checksPassed` and is not a model-quality comparison. Reports preserve base commits, CLI/source identity, edits, tests, tool calls, timing, usage certainty, and outcomes. Windows cancellation is driven through the installed Engine IPC fixture and does not claim OS CLI-signal qualification.

Model settings select `chat-completions`, `responses`, or `anthropic` per exact model name, with explicit capability and effort overrides. `OVOGO_MODEL_PROTOCOL` supplies an environment default. Native Anthropic uses `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL`; OpenAI protocols use `OPENAI_API_KEY` and `OPENAI_BASE_URL`. MiniMax keeps its existing compatible endpoint conversion unless native Anthropic is explicitly selected. Model names alone do not authorize unsupported effort parameters. Offline native fixtures qualify wire mapping, not a paid account's entitlement.

The run-family usage ledger includes main requests, compaction, critic, reflection, and child requests. It writes a pending unknown receipt before transport and one final receipt after settlement, so restarts cannot turn an unfinished request into a zero-cost success. Actual counters, token estimates, and unknown usage remain distinct. Reasoning output is a subset of total output. Cache prices require explicit read/write rates; absent rates leave cost unknown. Historical catalog prices carry `legacy-catalog-unverified`; exact billing requires a versioned per-model pricing override and provider qualification. Resetting a display retains durable receipts.

## Soak evidence

`soak:short` drives a real local stdio MCP subprocess for 10 seconds, with bounded concurrent requests and payloads. It records repeated host and child RSS, active Node resources, Linux file-descriptor counts, live fixture process count, pending requests, queued bytes, and post-close child liveness. Reports include measured growth and slope, not a single memory sample. Windows kernel handle counts are not measured; the report says so explicitly.

`pnpm run soak:long` selects the committed four-hour candidate profile. It uses the same real fixture and larger sustained payload/concurrency limits. It must be run separately on each supported OS before release. A short run never establishes the long-run result. The profiles cover the MCP lifecycle only; they do not substitute for process-tree, crash-recovery, provider-fault, or workspace-coordination regression suites.

Logs and reports are ignored under `.artifacts/production/release-*`; test workspaces and installed packages are ignored under `.artifacts/release-package-*`. Only synthetic fixture content is used. CI uploads reports for 14 days. It does not upload user home directories or project data.

## Upgrade and rollback

1. Record the old installed version and tarball hash. Stop accepting new work and wait for workers to confirm physical termination. If stopping fails, keep that workspace isolated and resolve its live processes before changing versions.
2. Preserve the entire runtime-data directory, workspace changes, and diagnostic reports. Copy data to a versioned backup; do not delete or rewrite the original with an older binary.
3. Install the candidate in a separate directory. Run its schema/installed smoke against fixtures first, then restore a copy of the intended history and verify compatibility. Unknown schema versions must refuse both loading and writing.
4. On rollback, stop the candidate workers, retain the candidate's new data separately, and restore the prior executable with a compatible data backup. The old executable must not write unknown newer schemas. Reconcile unknown operations before resuming non-idempotent actions; message history alone is not proof that a side effect did not happen.

The smoke verifies legacy-array/v1 loading and current writes, plus synthetic future-schema rejection. A real old-binary/new-data downgrade drill and a four-hour soak remain separate required candidate evidence; neither is implied by passing the fixture smoke. Formal publication and remote branch protection require explicit owner action.
