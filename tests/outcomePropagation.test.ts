import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExecutionEngine } from '../src/core/engine.js'
import { runSingleTask } from '../bin/ovogogogo.js'
import { runLoop } from '../src/core/loopEngine.js'
import { Renderer } from '../src/ui/renderer.js'
import { createSessionDir } from '../src/core/sessionManager.js'
import { AgentSessionClient } from '../src/core/agentSessionClient.js'

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
    cwd, sessionDir: createSessionDir(cwd), model: 'offline', apiKey: 'offline', permissionMode: 'auto', maxIterations: 3, enabledModules: [],
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
  it('blocks stale command evidence through Agent, parent Engine, and CLI', async () => {
    const { cwd, renderer, engine } = fixture()
    const turn = vi.spyOn(engine, 'runTurn')
    try {
      const status = await runSingleTask(engine, renderer, 'make the change', cwd, [], undefined)
      expect(existsSync(join(cwd, 'check-ran.txt'))).toBe(true)
      expect(status).toBe('blocked')
      expect((await turn.mock.results[0].value).result.outcomeReason).toEqual({ code: 'acceptance_invalidated' })
      expect(process.exitCode).toBe(2)
      expect(JSON.parse(readFileSync(join(cwd, 'ovogo_progress.json'), 'utf8')).current_step).toBe('blocked')
    } finally {
      await engine.dispose()
      renderer.destroy()
    }
  })

  it('blocks stale command evidence in Loop despite a stale DONE marker', async () => {
    const { cwd, renderer, engine } = fixture()
    const client = new AgentSessionClient({ engine, observer: renderer, cwd })
    const turn = vi.spyOn(engine, 'runTurn')
    const loopDir = join(cwd, '.loop')
    mkdirSync(loopDir)
    writeFileSync(join(loopDir, 'GOAL.md'), 'make the change')
    writeFileSync(join(loopDir, 'ACCEPTANCE.md'), '- [ ] A1: check `node check.cjs`')
    writeFileSync(join(loopDir, 'DONE.flag'), 'old accepted run')
    try {
      const result = await runLoop(client, renderer, { cwd, loopDir, maxIters: 1 })
      expect(existsSync(join(cwd, 'check-ran.txt'))).toBe(true)
      expect(result.status).toBe('blocked')
      expect((await turn.mock.results[0].value).result.outcomeReason).toEqual({ code: 'acceptance_invalidated' })
      expect(readFileSync(join(loopDir, 'DONE.flag'), 'utf8')).toBe('old accepted run')
      expect(result.outcomeReason).toEqual({ code: 'recovery_required', scope: 'operation' })
      expect(existsSync(join(loopDir, 'OUTCOME.json'))).toBe(false)
      expect(JSON.parse(readFileSync(join(client.sessionDir, 'loop-controller', 'state.json'), 'utf8')).current.phase).toBe('settled')
    } finally {
      await client.dispose()
      renderer.destroy()
    }
  })
})
