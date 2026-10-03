import { execSync } from 'node:child_process'
import type * as ChildProcess from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, generateBubblewrapArgs, generateMacOSProfile, getCachedProfile, invalidateProfileCache, loadConfig, saveConfig, wrapCommand } from '../../src/core/sandbox.js'
import { registerBuiltinCommands } from '../../src/commands/builtin.js'
import { clearRegistry, dispatchSlashCommand, type SlashCommandContext } from '../../src/commands/index.js'

vi.mock('node:child_process', async (importOriginal) => ({ ...await importOriginal<typeof ChildProcess>(), execSync: vi.fn(() => '') }))
let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'ovogo-sandbox-boundaries-')); vi.stubEnv('HOME', directory); vi.stubEnv('USERPROFILE', directory); invalidateProfileCache() })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); clearRegistry(); invalidateProfileCache(); rmSync(directory, { recursive: true, force: true }) })

describe('sandbox boundary contracts', () => {
  it('escapes literal profile paths containing quotes and backslashes', () => {
    const path = '/tmp/literal"\\name'
    expect(generateMacOSProfile({ ...DEFAULT_CONFIG, writablePaths: [path] }, '/project')).toContain('(subpath "/tmp/literal\\"\\\\name")')
  })

  it('masks a denied descendant even when its parent is mounted writable', () => {
    const denied = join(directory, 'secret')
    mkdirSync(denied)
    writeFileSync(join(denied, 'private'), 'secret')
    const args = generateBubblewrapArgs({ ...DEFAULT_CONFIG, deniedPaths: [denied] }, directory)
    expect(args).toContain('--tmpfs')
    expect(args.slice(args.indexOf('--tmpfs'), args.indexOf('--tmpfs') + 4)).toEqual(['--tmpfs', denied, '--remount-ro', denied])
  })

  it('wraps the entire shell command as one argument inside the sandbox', () => {
    vi.stubGlobal('process', new Proxy(process, { get(target, key): unknown { return key === 'platform' ? 'linux' : Reflect.get(target, key) } }))
    vi.mocked(execSync).mockReturnValue('bwrap')
    const command = "echo first && printf '%s' second"
    const wrapped = wrapCommand(command, directory, { ...DEFAULT_CONFIG, enabled: true })
    expect(wrapped).toContain("-c 'echo first && printf '\\''%s'\\'' second'")
  })

  it('recompiles cached profiles when the working directory changes', () => {
    saveConfig({ ...DEFAULT_CONFIG, enabled: true })
    const first = getCachedProfile(directory)
    expect(getCachedProfile(directory)).toBe(first)
    expect(getCachedProfile(join(directory, 'other'))).not.toBe(first)
  })

  it('does not share mutable default paths across configurations', () => {
    loadConfig().deniedPaths.push('accidental shared default')
    expect(loadConfig().deniedPaths).toEqual([])
  })

  it('refuses unavailable runtime isolation instead of claiming it was enabled', async () => {
    registerBuiltinCommands()
    const config = { executionProfile: undefined }
    const ctx = { cwd: directory, history: [], engine: { getConfig: () => config } } as unknown as SlashCommandContext
    const result = await dispatchSlashCommand('/sandbox on', ctx)
    expect(result).toMatchObject({ type: 'text', value: expect.stringContaining('unavailable') })
    expect(loadConfig().enabled).toBe(false)
  })

  it('refuses wrapping when the requested backend is unavailable', () => {
    vi.stubGlobal('process', new Proxy(process, { get(target, key): unknown { return key === 'platform' ? 'win32' : Reflect.get(target, key) } }))
    expect(() => wrapCommand('echo sensitive operation', directory, { ...DEFAULT_CONFIG, enabled: true })).toThrow(/unavailable/)
  })
})
