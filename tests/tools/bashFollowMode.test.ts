import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BashTool } from '../../src/tools/bash.js'

const dirs: string[] = []
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }) })

describe('Bash spectator mode', () => {
  it('preserves a failing command exit code while copying output', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'bash-follow-'))
    dirs.push(cwd)
    const result = await new BashTool().execute({ command: 'echo failure; exit 27', follow_mode: true }, { cwd, permissionMode: 'auto' })
    expect(result.content).toContain('Exit code: 27')
  })
})
