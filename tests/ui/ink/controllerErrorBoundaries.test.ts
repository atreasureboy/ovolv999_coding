import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionEngine } from '../../../src/core/engine.js'
import { InkRenderer } from '../../../src/ui/ink/inkRenderer.js'
import type { Renderer } from '../../../src/ui/renderer.js'
import { UIStore } from '../../../src/ui/ink/store.js'
import { createInkReplController } from '../../../src/ui/ink/replController.js'
import { getGitBranch, refreshGitBranch } from '../../../src/ui/ink/gitInfo.js'
import { registerBuiltinCommands } from '../../../src/commands/builtin.js'
import { clearRegistry } from '../../../src/commands/index.js'

const directories: string[] = []
afterEach(() => { vi.restoreAllMocks(); clearRegistry(); refreshGitBranch(); directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })) })
describe('Ink controller exception boundaries', () => {
  it('refreshes the visible branch after a real slash command changes it', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ovogo-ink-branch-'))
    directories.push(cwd)
    const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' })
    git('init', '--initial-branch=fixture')
    expect(getGitBranch(cwd)).toBe('fixture')
    writeFileSync(join(cwd, 'fixture.txt'), 'initial')
    git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'initial')
    const store = new UIStore()
    const renderer = new InkRenderer(store) as unknown as Renderer
    const engine = new ExecutionEngine({ cwd, apiKey: 'offline', model: 'gpt-4o', maxIterations: 1, permissionMode: 'auto', enabledModules: [] }, renderer)
    registerBuiltinCommands()
    const controller = createInkReplController({ cwd, engine, store, inkRenderer: renderer, skills: [], onExit: () => {} })
    await controller.dispatchSlash('/branch changed-fixture')
    expect(getGitBranch(cwd)).toBe('changed-fixture')
    await engine.dispose()
  })
  it.each([null, undefined, 42])('contains non-Error turn failures: %s', async failure => {
    const cwd = mkdtempSync(join(tmpdir(), 'ovogo-ink-error-'))
    directories.push(cwd)
    const store = new UIStore()
    const renderer = new InkRenderer(store) as unknown as Renderer
    const engine = new ExecutionEngine({ cwd, apiKey: 'offline', model: 'gpt-4o', maxIterations: 1, permissionMode: 'auto', enabledModules: [] }, renderer)
    vi.spyOn(engine, 'runTurn').mockRejectedValue(failure)
    const controller = createInkReplController({ cwd, engine, store, inkRenderer: renderer, skills: [], onExit: () => {} })
    await expect(controller.runTurn('fixture')).resolves.toMatchObject({ reason: 'error' })
    expect(store.getState()).toMatchObject({ running: false })
    expect(store.getState().messages).toContainEqual(expect.objectContaining({ type: 'error' }))
    await engine.dispose()
  })
})
