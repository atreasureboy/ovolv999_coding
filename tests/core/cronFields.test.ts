import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { parseCron, parseField } from '../../src/core/cron.js'

describe('cron field parsing', () => {
  it('rejects invalid range steps without blocking the caller', () => {
    const source = readFileSync(new URL('../../src/core/cron.ts', import.meta.url), 'utf8')
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText
    const script = compiled + `
      for (const field of ['1-5/0', '1-5/-2', '1-5/nope']) {
        try {
          exports.parseField(field, 'minute', 0, 59)
          console.log(field + ': accepted')
        } catch (error) {
          console.log(field + ': ' + (error instanceof exports.CronParseError ? 'rejected' : 'unexpected'))
        }
      }
    `
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 10_000,
    })
    expect(result.error === undefined).toBe(true)
    expect(result.status).toBe(0)
    expect(result.stdout.trim().split(/\r?\n/)).toEqual([
      '1-5/0: rejected',
      '1-5/-2: rejected',
      '1-5/nope: rejected',
    ])
  })

  it('uses the same name resolution for both range endpoints', () => {
    expect(parseCron('0 9 * * MON-FRI').dow).toEqual([1, 2, 3, 4, 5])
    expect(parseField('mon-FRI/2', 'dow', 0, 6)).toEqual([1, 3, 5])
    expect(parseField('JAN-MAR/2', 'month', 1, 12)).toEqual([1, 3])
  })

  it('preserves numeric range, wildcard step, sorting and Sunday boundaries', () => {
    expect(parseField('5,1-3,2', 'minute', 0, 59)).toEqual([1, 2, 3, 5])
    expect(parseField('*/15', 'minute', 0, 59)).toEqual([0, 15, 30, 45])
    expect(parseField('5-7', 'dow', 0, 6)).toEqual([5, 6, 7])
    expect(parseField('1-5/9', 'minute', 0, 59)).toEqual([1])
  })
})
