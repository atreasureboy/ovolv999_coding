import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let cwd: string
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'bash-background-')) })
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); rmSync(cwd, { recursive: true, force: true }) })

describe('Bash direct background startup', () => {
  it('reports a missing shell instead of successful startup with an undefined PID', async () => {
    vi.stubEnv('OVOGO_SHELL', join(cwd, 'missing-shell'))
    vi.resetModules()
    const { BashTool } = await import('../../src/tools/bash.js')
    const result = await new BashTool().execute({ command: 'echo unexpected', run_in_background: true }, { cwd, permissionMode: 'auto' })
    expect(result.isError).toBe(true)
    expect(result.content).not.toContain('PID: undefined')
  })
})
