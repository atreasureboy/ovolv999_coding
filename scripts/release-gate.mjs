import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { reports, root, run, runNode, runPnpm } from './release-utils.mjs'

mkdirSync(reports, { recursive: true })
const started = performance.now()
const results = []
let failure
try {
  const status = (await run('git', ['status', '--porcelain', '--untracked-files=normal'])).stdout.trim()
  if (status) throw new Error('Release gate requires a clean checkout; preserve and commit the intended changes first')
  const steps = [
    ['install', () => runPnpm(['install', '--frozen-lockfile'], { log: join(reports, 'release-install.log') })],
    ['typecheck', () => runNode([join(root, 'node_modules/typescript/bin/tsc'), '--noEmit'], { log: join(reports, 'release-typecheck.log') })],
    ['lint', () => runPnpm(['run', 'lint'], { log: join(reports, 'release-lint.log') })],
    ['test', () => runNode([join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=4'], { timeout: 600_000, log: join(reports, 'release-tests.log') })],
    ['build', () => runNode([join(root, 'scripts/build.mjs')], { log: join(reports, 'release-build.log') })],
    ['packed-cli', () => runPnpm(['run', 'test:package'], { timeout: 600_000, log: join(reports, 'release-package.log') })],
    ['short-soak', () => runPnpm(['run', 'soak:short'], { timeout: 180_000, log: join(reports, 'release-soak.log') })],
  ]
  for (const [name, action] of steps) {
    process.stdout.write(`Running release gate: ${name}\n`)
    const result = await action()
    results.push({ name, exitCode: result.code, durationMs: result.durationMs })
  }
} catch (error) {
  failure = error.message
  process.stderr.write(`${failure}\n`)
  process.exitCode = 1
} finally {
  writeFileSync(join(reports, 'release-gate.json'), JSON.stringify({ passed: !failure, platform: process.platform, node: process.version, durationMs: Math.round(performance.now() - started), results, failure }, null, 2) + '\n')
}
