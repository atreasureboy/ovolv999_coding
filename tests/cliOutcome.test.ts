import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runSingleTask } from '../bin/ovogogogo.js'
import type { ExecutionEngine } from '../src/core/engine.js'
import type { Renderer } from '../src/ui/renderer.js'

const previousExitCode = process.exitCode

afterEach(() => { process.exitCode = previousExitCode })

describe('CLI terminal outcomes', () => {
  it('bounds finalization and blocks reuse when execution ignores the deadline', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ovogo-cli-outcome-'))
    const engine = { runTurn: () => new Promise(() => {}), abort: vi.fn(), dispose: vi.fn() }
    const renderer = { humanPrompt: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }
    const start = Date.now()
    const status = await runSingleTask(engine as unknown as ExecutionEngine, renderer as unknown as Renderer, 'analyse', cwd, [], undefined, undefined, { deadlineMs: 10, finalizationMs: 20 })
    expect(status).toBe('blocked')
    expect(process.exitCode).toBe(2)
    expect(Date.now() - start).toBeLessThan(500)
    expect(engine.dispose).toHaveBeenCalledOnce()
  })
  it('sets a failure exit code and persists failed status for engine failure', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ovogo-cli-outcome-'))
    const engine = { runTurn: () => Promise.resolve({ result: { reason: 'error', output: 'provider rejected request' }, newHistory: [] }), abort: vi.fn() }
    const renderer = { humanPrompt: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }
    await runSingleTask(engine as unknown as ExecutionEngine, renderer as unknown as Renderer, 'analyse', cwd, [], undefined)
    expect(process.exitCode).toBe(1)
    const progress = JSON.parse(readFileSync(join(cwd, 'ovogo_progress.json'), 'utf8')) as { current_step: string }
    expect(progress.current_step).toBe('failed')
  })

  it('sets failed progress when execution throws', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ovogo-cli-outcome-'))
    const engine = { runTurn: () => Promise.reject(new Error('network unavailable')), abort: vi.fn() }
    const renderer = { humanPrompt: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }
    await runSingleTask(engine as unknown as ExecutionEngine, renderer as unknown as Renderer, 'analyse', cwd, [], undefined)
    expect(process.exitCode).toBe(1)
    const progress = JSON.parse(readFileSync(join(cwd, 'ovogo_progress.json'), 'utf8')) as { current_step: string }
    expect(progress.current_step).toBe('failed')
  })
})
