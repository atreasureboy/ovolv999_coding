import { mkdtempSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getExitPath, refreshSessionStatus, saveMetadata, stopSession, loadMetadata } from '../src/core/backgroundSession.js'

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('background terminal outcomes', () => {
  it('refuses to signal a legacy live PID without verified process identity', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ovogo-bg-outcome-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    saveMetadata({ id: 'cancel', task: 'task', cwd: home, pid: 424242, startedAt: new Date().toISOString(), status: 'running', logPath: join(home, 'log') })
    expect(await stopSession('cancel', 5)).toMatchObject({ accepted: false, status: 'failed' })
    expect(loadMetadata('cancel')?.status).toBe('running')
    expect(existsSync(getExitPath('cancel'))).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(kill).not.toHaveBeenCalledWith(424242, 'SIGKILL')
    expect(loadMetadata('cancel')?.status).toBe('running')
  })
  it('does not treat an exit code alone as an accepted task', () => {
    const home = mkdtempSync(join(tmpdir(), 'ovogo-bg-outcome-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    saveMetadata({ id: 'zero', task: 'task', cwd: home, pid: null, startedAt: new Date().toISOString(), status: 'running', logPath: join(home, 'log') })
    writeFileSync(getExitPath('zero'), '0\n')
    expect(refreshSessionStatus('zero')?.status).toBe('unknown')
  })
  it('preserves iteration limits instead of reporting a generic failure', () => {
    const home = mkdtempSync(join(tmpdir(), 'ovogo-bg-outcome-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    saveMetadata({ id: 'limit', task: 'task', cwd: home, pid: null, startedAt: new Date().toISOString(), status: 'running', logPath: join(home, 'log') })
    writeFileSync(getExitPath('limit'), '124\n')
    expect(refreshSessionStatus('limit')?.status).toBe('limit_reached')
  })
})
