# Architecture remediation baseline

- Audit SHA / actual starting HEAD: `bb5ed63c66636d790f6a2cc9707fc2c7d73cd0cd`.
- Remote: `https://github.com/atreasureboy/ovolv999_coding.git`.
- Initial working tree: clean. All remediation changes remain uncommitted until explicitly recorded otherwise.
- Host: Windows, Node `v24.20.0`, pnpm `11.25.0`. Linux checks have not run on this host.
- Commands verified against package.json and AGENTS.md: `pnpm install --frozen-lockfile`, `pnpm exec tsc --noEmit`, `pnpm run lint`, `pnpm exec vitest run`, `pnpm run build`.
- Lockfile: existing pnpm-lock.yaml retained; no dependency upgrades or second lockfile.

| Check | Initial result | Evidence |
| --- | --- | --- |
| Frozen install (sandbox) | network EACCES, interrupted with exit 1 | `.artifacts/architecture/baseline-install.log` |
| Frozen install (network allowed) | 228 dependencies installed; exit 1 because esbuild build script requires explicit pnpm configuration | `.artifacts/architecture/baseline-install-elevated.log` |
| Standard typecheck/lint/tests/build | exit 1 in pnpm dependency validation, before tools executed | `.artifacts/architecture/baseline-{typecheck,lint,tests,build}.log` |
| Direct local typecheck | exit 0 | `.artifacts/architecture/baseline-typecheck-direct.log` |

Full initial and final check results are recorded in the remediation report. New failure-first test files may appear in the initial full suite; they are distinguished from pre-existing failures there. No external-provider/live-service or Linux pass is inferred from offline Windows tests.

## Final comparison

- Clean copied-manifest frozen pnpm install: exit 0; `clean-frozen-install.log`.
- Full typecheck and build: exit 0; `final-typecheck.log`, `final-build.log`.
- Full tests: 3544 passed, 40 failed, 7 existing skipped; 151 files passed, 5 failed, no unhandled errors. Exit 1; `final-tests.log`.
- Full lint: 474 errors and 9 warnings, exit 1 (initial direct snapshot: 493 errors and 9 warnings). `final-lint.log`.
- npm pack, independent temporary installation, eight compiled CLI/offline HTTP smoke scenarios: exit 0; `package-final.json`, `package-final-install.log`, `package-final-smoke.log`.
- Remaining failures and limits are open in `docs/architecture-remediation.md`; these results do not assert release readiness.
