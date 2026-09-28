import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ExecutionEngine } from '../src/core/engine.js'
import { isWorkspaceQuarantined, quarantineWorkspace, withWorkspaceAccess } from '../src/core/runContext.js'
import type { Renderer } from '../src/ui/renderer.js'
import type OpenAI from 'openai'

const directories: string[] = []
const releases: Array<() => void> = []
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await Promise.resolve()
  for (const cwd of directories.splice(0)) rmSync(cwd, { recursive: true, force: true })
})

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'ovo-review-'))
  directories.push(cwd)
  const pending = new Promise<void>(resolve => releases.push(resolve))
  return { cwd, pending }
}

describe('runtime cancellation and quarantine regressions', () => {
  it('quarantines cleanup that outlives Engine.dispose timeout', async () => {
    const { cwd, pending } = fixture()
    const renderer = new Proxy({}, { get: () => () => undefined }) as Renderer
    const engine = new ExecutionEngine({ cwd, model: 'gpt-4o', apiKey: 'offline', maxIterations: 1, permissionMode: 'auto', enabledModules: [], cancellationGraceMs: 10 }, renderer)
    Reflect.set(engine, 'modules', [{ name: 'deferred-cleanup', dispose: () => pending }])
    await engine.dispose().catch(() => undefined)
    expect(isWorkspaceQuarantined(cwd)).toBe(true)
  })

  it('blocks acquisition when quarantine was added after a run started', async () => {
    const { cwd, pending } = fixture()
    expect(isWorkspaceQuarantined(cwd)).toBe(false)
    quarantineWorkspace(cwd, pending)
    let entered = false
    await withWorkspaceAccess(cwd, 'later-stage-of-running-engine', true, new AbortController().signal, () => {
      entered = true
      return Promise.resolve()
    }).catch(() => undefined)
    expect(entered).toBe(false)
  })

  it('bounds cancellation after the model has returned an uncooperative stream', async () => {
    const { cwd, pending } = fixture()
    let streamStarted!: () => void
    const started = new Promise<void>(resolve => { streamStarted = resolve })
    const client = { chat: { completions: { create: () => Promise.resolve((async function* () {
      streamStarted()
      await pending
      yield { choices: [] }
    })()) } } } as unknown as OpenAI
    const renderer = new Proxy({}, { get: () => () => undefined }) as Renderer
    const engine = new ExecutionEngine({ cwd, model: 'gpt-4o', apiKey: 'offline', maxIterations: 1, permissionMode: 'auto', enabledModules: [], cancellationGraceMs: 10 }, renderer, client)
    let returned = false
    const task = engine.runTurn('explain', []).then(() => { returned = true })
    try {
      await started
      engine.abort()
      await Promise.race([task, new Promise(resolve => setTimeout(resolve, 80))])
      expect(returned).toBe(true)
    } finally {
      for (const release of releases.splice(0)) release()
      await task
      await engine.dispose()
    }
  })
})
