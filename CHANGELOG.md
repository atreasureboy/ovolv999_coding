# Changelog

## Unreleased — 0.1.0 production reliability work

No npm release has been published by this remediation. A package version alone does not identify a candidate: retain its tarball SHA256 and `dist/build-info.json` source commit, source hash, and dirty flag.

- File-by-file correctness repairs for configuration layering, damaged persisted records, prototype keys, workspace-scoped caches, cron boundaries, and literal parameter substitution.
- Truthful timeout/cancellation and background-task outcomes; tracked descendants are stopped with birth-identity checks, and unconfirmed resources retain ownership.
- CLI/Ink history, cancellation, command context, workflow recursion, diagnostics, and exit cleanup fixes.
- Complete network-body deadlines, MCP error reporting, OAuth/LSP/daemon lifecycle and frame validation, and continuous UTF-8 output decoding.
- Shared local setup with pinned frozen dependencies, a fresh build, preserved environment configuration, and failure propagation. See [the file audit](docs/file-audit.md) for coverage, evidence, and external limits.
- Clean build before every pack; reproducible installed CLI, stdio protocol, permission, verification-failure, resume, and schema compatibility smoke.
- Windows/Linux CI gates at Node 22.13.0, latest 22.x, and 24.x; all typecheck, lint, and tests must pass before a candidate is accepted.
- Budget periods now use UTC consistently, including ISO-week Monday and month boundaries. Existing daily/monthly keys already use UTC. Old weekly entries produced with local midnight are retained; review that week's usage before relying on the corrected enforcement boundary.
- Documentation discovery uses portable glob matching and native absolute path handling.
- Windows file modes follow native read-only/writable attributes; POSIX executable bits are not a Windows contract. File-symlink behavior requires symlink creation rights; directory-junction tests provide Windows coverage without those rights.
- Formal execution policies with minimal managed child environments, explicit per-server environment grants, fail-closed configuration loading, and refusal of unavailable isolation or quotas. Legacy synchronous helpers and descendant accounting remain outside the completed migration.
- Serialized terminal/Ink approvals bound to the complete operation, workspace, and current policy; safe display of control characters, cancellation fences, and headless needs_input outcomes. Durable and remote approvals remain pending.
- Atomic explicit memory corrections retain superseded history while runtime consumers use active entries; detached snapshots, bounded correction metadata, and failed-refresh withholding prevent obsolete cached instructions from returning.

See [release support and rollback](docs/release-support.md) and [capability assembly](docs/architecture-capabilities.md) for scope and limitations. Release gating is implemented, but its presence is not a passing release result.
