import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExecutionEngine } from '../src/core/engine.js'
import { runSingleTask } from '../bin/ovogogogo.js'
import { runLoop } from '../src/core/loopEngine.js'
import { Renderer } from '../src/ui/renderer.js'

const oldExitCode = process.exitCode
afterEach(() => { process.exitCode = oldExitCode })

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'ovogo-outcome-chain-'))
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node check.cjs' } }))
  writeFileSync(join(cwd, 'check.cjs'), "require('fs').writeFileSync('check-ran.txt','yes'); process.exit(7)")
  const renderer = Renderer.forFile(join(tmpdir(), `ovogo-outcome-${Date.now()}-${Math.random()}.log`))
  let calls = 0
  const client = { chat: { completions: { create: () => {
    const call = calls++
    return Promise.resolve((async function* () {
      await Promise.resolve()
      if (call === 0) yield { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'delegate', type: 'function', function: { name: 'Agent', arguments: JSON.stringify({ description: 'change', prompt: 'change source', verify: false }) } }] }, finish_reason: 'tool_calls' }] }
      else yield { choices: [{ index: 0, delta: { content: 'I completed the task.' }, finish_reason: 'stop' }] }
    })())
  } } } }
  const engine = new ExecutionEngine({
    cwd, model: 'offline', apiKey: 'offline', permissionMode: 'auto', maxIterations: 3, enabledModules: [],
    agentFactory: () => ({
      runTurn: () => {
        writeFileSync(join(cwd, 'source.ts'), 'export const value = 2')
        return Promise.resolve({ result: { reason: 'stop_sequence', output: 'Changed source.' } })
      },
      abort: () => {},
      dispose: () => {},
    }),
  }, renderer, client as unknown as ConstructorParameters<typeof ExecutionEngine>[2])
  return { cwd, renderer, engine }
}

describe('actual command failure propagation', () => {
  it('propagates a failing project command through Agent, parent Engine, and CLI', async () => {
    const { cwd, renderer, engine } = fixture()
    try {
      const status = await runSingleTask(engine, renderer, 'make the change', cwd, [], undefined)
      expect(existsSync(join(cwd, 'check-ran.txt'))).toBe(true)
      expect(status).toBe('failed')
      expect(process.exitCode).toBe(1)
      expect(JSON.parse(readFileSync(join(cwd, 'ovogo_progress.json'), 'utf8')).current_step).toBe('failed')
    } finally {
      await engine.dispose()
      renderer.destroy()
    }
  })

  it('propagates the same failure into Loop despite a stale DONE marker', async () => {
    const { cwd, renderer, engine } = fixture()
    const loopDir = join(cwd, '.loop')
    mkdirSync(loopDir)
    writeFileSync(join(loopDir, 'GOAL.md'), 'make the change')
    writeFileSync(join(loopDir, 'ACCEPTANCE.md'), '- [ ] A1: check `node check.cjs`')
    writeFileSync(join(loopDir, 'DONE.flag'), 'old accepted run')
    try {
      const result = await runLoop(engine, renderer, { cwd, loopDir, maxIters: 1 })
      expect(existsSync(join(cwd, 'check-ran.txt'))).toBe(true)
      expect(result.status).toBe('failed')
    } finally {
      await engine.dispose()
      renderer.destroy()
    }
  })
})
