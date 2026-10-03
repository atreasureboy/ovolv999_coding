import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execRemote, getProfile, loadProfiles, runRemoteAgent, syncUp } from '../../src/core/sshRemote.js'
import type * as ChildProcess from 'child_process'

const native = vi.hoisted(() => ({ requests: [] as Array<{ executable: string; args: string[] }>, failSync: false }))
vi.mock('child_process', async importOriginal => ({
  ...await importOriginal<typeof ChildProcess>(),
  execSync: (command: string) => { native.requests.push({ executable: 'shell', args: [command] }); return '' },
  execFileSync: (executable: string, args: string[]) => {
    native.requests.push({ executable, args })
    if (executable === 'rsync' && native.failSync) throw new Error('sync unavailable')
    return ''
  },
}))
let fixture: string
beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'ssh boundary regression '))
  vi.stubEnv('HOME', fixture)
  vi.stubEnv('USERPROFILE', fixture)
  native.requests.length = 0
  native.failSync = false
})
afterEach(() => { vi.unstubAllEnvs(); rmSync(fixture, { recursive: true, force: true }) })
const profile = { name: 'fixture', host: 'fixture.invalid', remoteBase: '/srv/remote work' }

describe('SSH local and remote command boundaries', () => {
  it('passes local argv and exports variables for the command after changing directories', () => {
    expect(execRemote(profile, 'node app.js', { cwd: '/srv/remote work', env: { VALUE: 'a b' } }).exitCode).toBe(0)
    expect(native.requests[0].executable).toBe('ssh')
    expect(native.requests[0].args.at(-1)).toContain("export VALUE='a b'; cd '/srv/remote work' && node app.js")
  })

  it('constructs remote rsync paths with forward slashes and preserves key-file arguments', () => {
    expect(syncUp({ ...profile, identityFile: '/key folder/id' }, 'local folder', 'project/subdir')).toBe(true)
    const request = native.requests.find(r => r.executable === 'rsync')
    expect(request?.args.at(-1)).toBe('fixture.invalid:/srv/remote work/project/subdir')
    expect(request?.args.find(a => a.startsWith('ssh '))).toContain("'/key folder/id'")
  })

  it('stops before launching the agent if upload failed', () => {
    native.failSync = true
    expect(runRemoteAgent(profile, { task: 'change code', syncBefore: true })).toMatchObject({ success: false, syncedUp: false })
    expect(native.requests.filter(r => r.executable === 'ssh').some(r => r.args.at(-1)?.includes('ovolv999 --pipe'))).toBe(false)
  })

  it('ignores malformed profiles without breaking lookups', () => {
    mkdirSync(join(fixture, '.ovolv999'))
    writeFileSync(join(fixture, '.ovolv999', 'ssh-profiles.json'), JSON.stringify({ name: 'invalid' }))
    expect(loadProfiles()).toEqual([])
    expect(getProfile('invalid')).toBeUndefined()
  })
})
