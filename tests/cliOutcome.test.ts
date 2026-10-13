import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runSingleTask } from '../bin/ovogogogo.js'
import { ExecutionEngine } from '../src/core/engine.js'
import type { Renderer } from '../src/ui/renderer.js'
import { createSessionDir } from '../src/core/sessionManager.js'

const previousExitCode = process.exitCode
const directories: string[] = []

afterEach(() => {
  process.exitCode = previousExitCode
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'ovogo-cli-outcome-'))
  directories.push(cwd)
  const renderer = new Proxy({}, { get: () => vi.fn() }) as Renderer
  const engine = new ExecutionEngine({ cwd, sessionDir: createSessionDir(cwd), apiKey: 'offline', model: 'offline', enabledModules: [], maxIterations: 1, permissionMode: 'auto' }, renderer)
  return { cwd, renderer, engine }
}

describe('CLI terminal outcomes', () => {
  it('bounds finalization and blocks reuse when execution ignores the deadline', async () => {
    const { cwd, engine, renderer } = fixture()
    vi.spyOn(engine, 'runTurn').mockImplementation(() => new Promise(() => {}))
    const dispose = vi.spyOn(engine, 'dispose')
    const start = Date.now()
    const status = await runSingleTask(engine, renderer, 'analyse', cwd, [], undefined, undefined, { deadlineMs: 10, finalizationMs: 20 })
    expect(status).toBe('blocked')
    expect(process.exitCode).toBe(2)
    expect(Date.now() - start).toBeLessThan(500)
    expect(dispose).toHaveBeenCalledOnce()
  })
  it('sets a failure exit code and persists failed status for engine failure', async () => {
    const { cwd, engine, renderer } = fixture()
    vi.spyOn(engine, 'runTurn').mockResolvedValue({ result: { stopped: true, reason: 'error', output: 'provider rejected request' }, newHistory: [], turnMessages: [] })
    await runSingleTask(engine, renderer, 'analyse', cwd, [], undefined)
    expect(process.exitCode).toBe(1)
    const progress = JSON.parse(readFileSync(join(cwd, 'ovogo_progress.json'), 'utf8')) as { current_step: string }
    expect(progress.current_step).toBe('failed')
  })

  it('sets failed progress when execution throws', async () => {
    const { cwd, engine, renderer } = fixture()
    vi.spyOn(engine, 'runTurn').mockRejectedValue(new Error('network unavailable'))
    await runSingleTask(engine, renderer, 'analyse', cwd, [], undefined)
    expect(process.exitCode).toBe(1)
    const progress = JSON.parse(readFileSync(join(cwd, 'ovogo_progress.json'), 'utf8')) as { current_step: string }
    expect(progress.current_step).toBe('failed')
  })
})
