import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let cwd: string
beforeAll(() => { if (process.platform === 'win32') execFileSync(process.execPath, ['native/execution-host/build.mjs'], { windowsHide: true }) })
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'bash-background-')) })
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); rmSync(cwd, { recursive: true, force: true }) })

describe('Bash direct background startup', () => {
  it.each([true, false])('reports a missing shell after physical startup settlement (background=%s)', async run_in_background => {
    vi.stubEnv('OVOGO_SHELL', join(cwd, 'missing-shell'))
    vi.resetModules()
    const { BashTool } = await import('../../src/tools/bash.js')
    const { createProcessScope, getExecutionHealth } = await import('../../src/core/executionBackend.js')
    const native = await import('../../src/core/managedChildProcess.js')
    const launch = vi.spyOn(native, 'spawnManagedChildProcess')
    const scope = createProcessScope()
    const before = getExecutionHealth().activeProcesses
    try {
      const result = await scope.run(() => new BashTool().execute({ command: 'echo unexpected', run_in_background }, { cwd, permissionMode: 'auto' }))
      expect(result.isError).toBe(true)
      expect(result.content).not.toContain('PID: undefined')
      expect(scope.pending.size).toBe(0)
      expect(getExecutionHealth().activeProcesses).toBe(before)
      if (process.platform === 'win32') {
        const child = launch.mock.results[0]?.value as ReturnType<typeof native.spawnManagedChildProcess>
        expect(child.physicalState).toBe('settled')
        expect(() => process.kill(child.managedProcess!.controllerPid!, 0)).toThrow()
      }
    } finally {
      for (const entry of launch.mock.results) if (entry.type === 'return') await entry.value.physicallySettled
      launch.mockRestore()
    }
  })
})
