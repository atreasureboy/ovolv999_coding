import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { BashTool } from '../src/tools/bash.js'
import { BackgroundTaskManager } from '../src/core/backgroundTaskManager.js'
import { EnterWorktreeTool, WorktreeManager, _resetWorktreeManagersForTest } from '../src/tools/worktree.js'

const directories: string[] = []
afterEach(() => {
  _resetWorktreeManagersForTest()
  for (const cwd of directories.splice(0)) rmSync(cwd, { recursive: true, force: true })
})

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'ovo-git-gate-'))
  directories.push(cwd)
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' })
  git('init', '-b', 'main')
  git('config', 'user.email', 'tests@example.invalid')
  git('config', 'user.name', 'Test')
  writeFileSync(join(cwd, 'tracked.txt'), 'base')
  git('add', '.')
  git('commit', '-m', 'base')
  const child = new WorktreeManager(cwd).createWorktree('existing')
  writeFileSync(join(child.path, 'wait.cjs'), "const fs=require('fs');fs.writeFileSync('started','1');const t=setInterval(()=>{if(fs.existsSync('release'))clearInterval(t)},10)")
  const command = 'node wait.cjs && git branch coordinated'
  return { cwd, child, command }
}

async function started(cwd: string) {
  const deadline = Date.now() + 5_000
  while (!existsSync(join(cwd, 'started'))) {
    if (Date.now() > deadline) throw new Error('Background process did not start')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('shared repository administration', () => {
  it('cancels a queued native mutation without creating a branch', async () => {
    const { cwd, child, command } = fixture()
    const running = new BashTool().execute({ command }, { cwd: child.path, permissionMode: 'auto' })
    const controller = new AbortController()
    try {
      await started(child.path)
      const creation = new EnterWorktreeTool().execute({ name: 'cancelled' }, { cwd, permissionMode: 'auto', signal: controller.signal })
      controller.abort()
      expect((await creation).isError).toBe(true)
      expect(existsSync(join(cwd, '.ovolv999', 'worktrees', 'cancelled'))).toBe(false)
      expect(execFileSync('git', ['branch', '--list', 'wt/cancelled'], { cwd, encoding: 'utf8' }).trim()).toBe('')
    } finally {
      writeFileSync(join(child.path, 'release'), '1')
      await running
    }
  })

  it('allows a different repository to mutate while one Git directory is busy', async () => {
    const first = fixture()
    const second = fixture()
    const running = new BashTool().execute({ command: first.command }, { cwd: first.child.path, permissionMode: 'auto' })
    try {
      await started(first.child.path)
      const result = await new EnterWorktreeTool().execute({ name: 'independent' }, { cwd: second.cwd, permissionMode: 'auto' })
      expect(result.isError).toBe(false)
      expect(existsSync(join(first.child.path, 'release'))).toBe(false)
    } finally {
      writeFileSync(join(first.child.path, 'release'), '1')
      await running
    }
  })

  for (const mode of ['foreground', 'background', 'managed background'] as const) {
    it(`holds the common Git directory until ${mode} child exits`, async () => {
      const { cwd, child, command } = fixture()
      const manager = mode === 'managed background' ? new BackgroundTaskManager() : undefined
      const controller = new AbortController()
      const commandTask = new BashTool().execute({ command, run_in_background: mode !== 'foreground' }, {
        cwd: child.path, permissionMode: 'auto', signal: controller.signal, backgroundTaskManager: manager,
      })
      let creationFinished = false
      let creation: ReturnType<EnterWorktreeTool['execute']> | undefined
      try {
        await started(child.path).catch(error => {
          throw new Error(`${(error as Error).message}: ${JSON.stringify(manager?.listTasks().map(task => manager.getTaskDetail(task.id)))}`, { cause: error })
        })
        if (mode !== 'foreground') expect((await commandTask).isError).toBe(false)
        creation = new EnterWorktreeTool().execute({ name: 'next' }, { cwd, permissionMode: 'auto' })
        void creation.then(() => { creationFinished = true })
        await new Promise(resolve => setTimeout(resolve, 80))
        expect(creationFinished).toBe(false)
      } finally {
        writeFileSync(join(child.path, 'release'), '1')
        await commandTask
        if (creation) await creation
        if (manager) {
          for (const task of manager.listTasks()) await manager.waitForTask(task.id, 5_000)
          manager.dispose()
        }
      }
      expect(creationFinished).toBe(true)
    }, 15_000)
  }
})
