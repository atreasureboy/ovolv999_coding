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

`ovolv999 --version` reports package version, source SHA, and a dirty marker. `dist/build-info.json` additionally records a SHA256 of build input paths and content, build time, and build Node version. The tarball hash is in `.artifacts/production/release-package-smoke.json`. Dirty candidates are useful for local diagnosis but are rejected by the release gate.

The installed smoke uses a loopback-only provider and fixture files. It exercises help/version without an API key, the actual installed command shim, raw pipe without tools, single task, stdin task, resume, ask denial, failing verification, successful read/edit/verification, legacy-session migration, future-version refusal without overwrite, ACP stdio capability negotiation with disabled file handlers, runtime recovery status, and physical shutdown of a fixture parent/child process tree. It does not contact a paid model or demonstrate compatibility with every external editor/MCP server.

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
