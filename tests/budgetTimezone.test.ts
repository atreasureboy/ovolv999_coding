import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ModuleKind, transpileModule } from 'typescript'

let runtime: string
beforeAll(() => {
  runtime = mkdtempSync(join(tmpdir(), 'ovo-budget-timezone-'))
  writeFileSync(join(runtime, 'package.json'), '{"type":"module"}')
  for (const name of ['budget', 'persistedData']) {
    const source = readFileSync(new URL(`../src/core/${name}.ts`, import.meta.url), 'utf8')
    writeFileSync(join(runtime, `${name}.js`), transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: 9 } }).outputText)
  }
})
afterAll(() => rmSync(runtime, { recursive: true, force: true }))

describe('budget UTC period contract', () => {
  it.each(['UTC', 'Asia/Shanghai', 'America/New_York'])('uses the same boundaries in %s', (timezone) => {
    const moduleUrl = pathToFileURL(join(runtime, 'budget.js')).href
    const script = `
      import { getPeriodKey, getPeriodStart, getPeriodEnd } from ${JSON.stringify(moduleUrl)};
      const date = new Date('2025-03-09T23:30:00Z');
      const results = ['daily', 'weekly', 'monthly'].map(period => ({
        key: getPeriodKey(period, date),
        start: getPeriodStart(period, date).toISOString(),
        end: getPeriodEnd(period, date).toISOString(),
      }));
      process.stdout.write(JSON.stringify(results));
    `
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, TZ: timezone },
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual([
      { key: '2025-03-09', start: '2025-03-09T00:00:00.000Z', end: '2025-03-10T00:00:00.000Z' },
      { key: '2025-03-03', start: '2025-03-03T00:00:00.000Z', end: '2025-03-10T00:00:00.000Z' },
      { key: '2025-03', start: '2025-03-01T00:00:00.000Z', end: '2025-04-01T00:00:00.000Z' },
    ])
  })
})
