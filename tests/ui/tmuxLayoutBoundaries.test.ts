import type * as ChildProcess from 'node:child_process'
import { execFileSync, execSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TmuxLayout } from '../../src/ui/tmuxLayout.js'

const state = vi.hoisted(() => ({ listing: '', failRename: false }))
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof ChildProcess>()
  const run = (command: string): Buffer => {
    if (command.includes('tmux ls')) return Buffer.from(state.listing)
    if (state.failRename && command.includes('rename-window')) throw new Error('rename failed')
    return Buffer.alloc(0)
  }
  return { ...original, spawnSync: vi.fn(() => ({ status: 0 })), execSync: vi.fn(run), execFileSync: vi.fn((file: string, args: string[]) => run([file, ...args].join(' '))) }
})

let directory: string
function commands(): string[] {
  return [...vi.mocked(execSync).mock.calls.map(([command]) => command), ...vi.mocked(execFileSync).mock.calls.map(([file, args]) => [file, ...(args ?? [])].join(' '))]
}
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'ovogo-tmux-layout-')); state.listing = ''; state.failRename = false; vi.clearAllMocks() })
afterEach(() => { vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }) })

describe('tmux monitor ownership', () => {
  it('preserves old unattached sessions whose owner is still alive', () => {
    state.listing = `ovogo-24680-abcdef||${Math.floor(Date.now() / 1000) - 7200}||0\n`
    vi.spyOn(process, 'kill').mockImplementation(() => true)
    const layout = new TmuxLayout()
    expect(layout.init(directory)).toBe(true)
    expect(commands().some(command => command.includes('kill-session') && command.includes('ovogo-24680-abcdef'))).toBe(false)
    layout.destroy()
  })

  it('removes its own partially initialized session after a window setup failure', () => {
    state.failRename = true
    expect(new TmuxLayout().init(directory)).toBe(false)
    expect(commands().filter(command => command.includes('kill-session'))).toHaveLength(1)
  })

  it('uses distinct window targets for agents with identical labels', () => {
    const layout = new TmuxLayout()
    expect(layout.init(directory)).toBe(true)
    layout.acquireSlot('same label'); layout.acquireSlot('same label')
    expect(new Set(commands().filter(command => command.includes('new-window'))).size).toBe(2)
    layout.destroy()
  })
})
