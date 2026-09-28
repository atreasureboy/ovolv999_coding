import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { runLoop } from '../src/core/loopEngine.js'
import type { ExecutionEngine } from '../src/core/engine.js'
import type { Renderer } from '../src/ui/renderer.js'

describe('Loop controller acceptance', () => {
  it('rejects an empty acceptance definition even with a forged completion marker', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ovogo-loop-outcome-'))
    const loopDir = join(cwd, '.loop')
    mkdirSync(loopDir)
    writeFileSync(join(loopDir, 'GOAL.md'), 'finish')
    writeFileSync(join(loopDir, 'DONE.flag'), 'done')
    const renderer = { info: vi.fn(), success: vi.fn(), error: vi.fn(), warn: vi.fn() }
    const engine = { runTurn: vi.fn() }
    const result = await runLoop(engine as unknown as ExecutionEngine, renderer as unknown as Renderer, { cwd, loopDir, maxIters: 1 })
    expect(result.status).toBe('blocked')
    expect(result.verification.status).toBe('not_applicable')
    expect(engine.runTurn).not.toHaveBeenCalled()
  })

  it('blocks an agent that rewrites frozen acceptance and forges DONE', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ovogo-loop-outcome-'))
    const loopDir = join(cwd, '.loop')
    mkdirSync(loopDir)
    writeFileSync(join(loopDir, 'GOAL.md'), 'finish')
    writeFileSync(join(loopDir, 'ACCEPTANCE.md'), '- [ ] A1: check `node -e "process.exit(1)"`')
    const renderer = { info: vi.fn(), success: vi.fn(), error: vi.fn(), warn: vi.fn() }
    const engine = { runTurn: () => {
      writeFileSync(join(loopDir, 'ACCEPTANCE.md'), '- [x] A1: check `node -e "process.exit(0)"`')
      writeFileSync(join(loopDir, 'DONE.flag'), 'accepted')
      return Promise.resolve({ result: { reason: 'stop_sequence', output: 'done' } })
    } }
    const result = await runLoop(engine as unknown as ExecutionEngine, renderer as unknown as Renderer, { cwd, loopDir, maxIters: 1 })
    expect(result.status).toBe('blocked')
    expect(renderer.success).not.toHaveBeenCalled()
  })
  it('executes frozen failing acceptance despite an existing DONE marker', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ovogo-loop-outcome-'))
    const loopDir = join(cwd, '.loop')
    mkdirSync(loopDir)
    writeFileSync(join(loopDir, 'GOAL.md'), 'pass the check')
    writeFileSync(join(loopDir, 'ACCEPTANCE.md'), '- [ ] A1: check `node check.cjs`')
    writeFileSync(join(loopDir, 'DONE.flag'), 'completed in a previous run')
    writeFileSync(join(cwd, 'check.cjs'), "require('fs').writeFileSync('checked.txt','yes'); process.exit(1)")
    const renderer = { info: vi.fn(), success: vi.fn(), error: vi.fn(), warn: vi.fn() }
    const engine = { runTurn: () => Promise.resolve({ result: { reason: 'stop_sequence', output: 'done' } }) }
    await runLoop(engine as unknown as ExecutionEngine, renderer as unknown as Renderer, { cwd, loopDir, maxIters: 1 })
    expect(existsSync(join(cwd, 'checked.txt'))).toBe(true)
    expect(renderer.success).not.toHaveBeenCalled()
  })
})
