import type * as ChildProcess from 'node:child_process'
import { execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runSystemHealthChecks } from '../../src/utils/systemHealth.js'
import { runDoctorChecks } from '../../src/utils/doctor.js'

vi.mock('node:child_process', async (importOriginal) => ({ ...await importOriginal<typeof ChildProcess>(), execSync: vi.fn(() => { throw new Error('offline fixture') }) }))
let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'ovogo-health-boundaries-')); vi.stubEnv('HOME', directory); vi.stubEnv('USERPROFILE', directory) })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(directory, { recursive: true, force: true }) })

describe('diagnostic accuracy boundaries', () => {
  it('returns a structured error when configuration directories are files', () => {
    mkdirSync(join(directory, '.ovolv999'))
    writeFileSync(join(directory, '.ovolv999', 'workflows'), 'not a directory')
    expect(runDoctorChecks(directory).results).toContainEqual(expect.objectContaining({ category: 'structure', item: '.ovolv999/workflows', level: 'error' }))
  })

  it('rejects Node versions below the package runtime requirement', () => {
    vi.stubGlobal('process', new Proxy(process, { get(target, key): unknown { return key === 'versions' ? { ...target.versions, node: '20.0.0' } : Reflect.get(target, key) } }))
    expect(runSystemHealthChecks().checks.find(check => check.id === 'node-version')).toMatchObject({ level: 'error', message: expect.stringContaining('22.13.0') })
  })

  it('checks disk capacity without parsing localized shell output', () => {
    expect(runSystemHealthChecks().environment.diskFreeMB).toBeGreaterThan(0)
  })

  it('reports the tool package installation instead of the Node installation', () => {
    expect(runSystemHealthChecks().checks.find(check => check.id === 'install-location')?.message).toContain(process.cwd())
  })

  it('does not count an empty global npm directory as another installation', () => {
    const globalRoot = join(directory, 'global-root')
    mkdirSync(globalRoot)
    vi.mocked(execSync).mockImplementation(command => { if (command.startsWith('npm root -g')) return globalRoot; throw new Error('offline fixture') })
    expect(runSystemHealthChecks().checks.find(check => check.id === 'multiple-installs')).toMatchObject({ level: 'ok', message: 'No other installations found' })
  })
})
