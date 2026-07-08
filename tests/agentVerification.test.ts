import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { detectVerifyCommands } from '../src/tools/agent.js'

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'ovogo-verify-'))
}

describe('detectVerifyCommands', () => {
  it('uses package scripts in deterministic order', () => {
    const cwd = tmpProject()
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({
      scripts: {
        test: 'vitest run',
        lint: 'eslint .',
        build: 'tsc',
      },
    }), 'utf8')

    expect(detectVerifyCommands(cwd)).toEqual([
      'npm run build 2>&1',
      'npm run lint 2>&1',
      'npm test 2>&1',
    ])
  })

  it('prefers typecheck over build when both exist', () => {
    const cwd = tmpProject()
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({
      scripts: {
        typecheck: 'tsc --noEmit',
        build: 'vite build',
      },
    }), 'utf8')

    expect(detectVerifyCommands(cwd)).toEqual(['npm run typecheck 2>&1'])
  })

  it('falls back to tsc for tsconfig without package scripts', () => {
    const cwd = tmpProject()
    writeFileSync(join(cwd, 'tsconfig.json'), '{}', 'utf8')

    expect(detectVerifyCommands(cwd)).toEqual(['npx tsc --noEmit 2>&1'])
  })
})
