import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { runLoop } from '../../src/core/loopEngine.js'
import { quarantineWorkspace, withWorkspaceAccess } from '../../src/core/runContext.js'
import * as verification from '../../src/core/verification.js'
import type { ExecutionEngine } from '../../src/core/engine.js'
import type { Renderer } from '../../src/ui/renderer.js'

const directories: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(accept => { resolve = accept })
  return { promise, resolve }
}

function setup() {
  const cwd = mkdtempSync(join(tmpdir(), 'ovo-loop-workspace-audit-'))
  directories.push(cwd)
  const loopDir = join(cwd, '.loop')
  mkdirSync(loopDir)
  writeFileSync(join(loopDir, 'GOAL.md'), 'check artifact')
  writeFileSync(join(loopDir, 'ACCEPTANCE.md'), '- [ ] A1: check `node check.cjs`')
  writeFileSync(join(cwd, 'check.cjs'), "require('fs').writeFileSync('.loop/checked.txt', 'checked')")
  const engine = { runTurn: () => Promise.resolve({ result: { reason: 'stop_sequence', status: 'completed', output: 'done' } }), abort: vi.fn(), getConfig: () => ({}) } as unknown as ExecutionEngine
  const renderer = new Proxy({}, { get: () => () => undefined }) as Renderer
  return { cwd, loopDir, engine, renderer }
}

it('waits for workspace ownership before hashing and running loop checks', async () => {
  const { cwd, loopDir, engine, renderer } = setup()
  const entered = deferred()
  const released = deferred()
  const holder = withWorkspaceAccess(cwd, 'other-family', true, new AbortController().signal, async () => {
    entered.resolve()
    await released.promise
  })
  await entered.promise
  const capture = vi.spyOn(verification, 'captureArtifactVersion')
  const pending = runLoop(engine, renderer, { cwd, loopDir, maxIters: 1 })
  let settled = false
  void pending.then(() => { settled = true })
  try {
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(capture).not.toHaveBeenCalled()
    expect(existsSync(join(loopDir, 'checked.txt'))).toBe(false)
    expect(settled).toBe(false)
  } finally {
    released.resolve()
    await holder
    await pending
  }
  expect((await pending).status).toBe('completed')
  expect(existsSync(join(loopDir, 'checked.txt'))).toBe(true)
})

it('blocks loop verification in a quarantined workspace before starting commands', async () => {
  const { cwd, loopDir, engine, renderer } = setup()
  const unsettled = deferred()
  quarantineWorkspace(cwd, unsettled.promise)
  try {
    const result = await runLoop(engine, renderer, { cwd, loopDir, maxIters: 1 })
    expect(result.status).toBe('blocked')
    expect(existsSync(join(loopDir, 'checked.txt'))).toBe(false)
  } finally {
    unsettled.resolve()
    await unsettled.promise
  }
})
