import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type OpenAI from 'openai'
import { afterEach, expect, it, vi } from 'vitest'
import { ExecutionEngine } from '../../../src/core/engine.js'
import { UsageLedger } from '../../../src/core/usageLedger.js'
import type { EngineObserver } from '../../../src/core/engine/observer.js'

const fixtures: Array<{ engine: ExecutionEngine; cwd: string }> = []
afterEach(async () => { for (const { engine, cwd } of fixtures.splice(0)) { await engine.dispose(); rmSync(cwd, { recursive: true, force: true }) } })

it('includes auxiliary gateway calls in engine costs without counting its primary stream twice', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ovo-engine-usage-'))
  const ledger = new UsageLedger({ pricing: () => ({ version: 'fixture', inputPer1M: 2, outputPer1M: 10 }) })
  const client = { chat: { completions: { create: async (params: { stream?: boolean }) => {
    await Promise.resolve()
    const completion = { choices: [{ message: { role: 'assistant', content: 'ready' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } }
    return params.stream ? (async function* () { await Promise.resolve(); yield { choices: [{ delta: { content: 'ready' }, finish_reason: 'stop' }], usage: completion.usage } })() : completion
  } } } } as unknown as OpenAI
  const observer = new Proxy({}, { get: () => vi.fn() }) as EngineObserver
  const engine = new ExecutionEngine({ cwd, model: 'fixture', apiKey: 'fixture', maxIterations: 1, permissionMode: 'deny', enabledModules: [], usageLedger: ledger, agent: { identity: { systemPrompt: () => 'fixture' }, tools: [] } }, observer, client)
  fixtures.push({ engine, cwd })
  await engine.runTurn('main request', [])
  for (const name of ['compact', 'critic', 'reflection']) await engine.getModelClient().chat.completions.create({ model: 'fixture', messages: [{ role: 'user', content: name }] })
  expect(engine.getCostTracker().getTotalAPICalls()).toBe(4)
  expect(engine.getCostTracker().getTotalInputTokens()).toBe(400)
  expect(engine.getCostTracker().getTotalCost()).toBeCloseTo(0.0012, 12)
  expect(ledger.records()).toHaveLength(4)
})
