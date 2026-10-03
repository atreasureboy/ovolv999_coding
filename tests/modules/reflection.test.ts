import type OpenAI from 'openai'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { EpisodicMemory } from '../../src/core/episodicMemory.js'
import { SemanticMemory } from '../../src/core/semanticMemory.js'
import { ReflectionModule, consolidateSession } from '../../src/modules/reflection.js'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ovo-reflection-'))
  directories.push(directory)
  const requests: Array<{ model: string; signal?: AbortSignal; timeout?: number; maxRetries?: number }> = []
  const client = {
    chat: { completions: { create: (params: { model: string }, options: { signal?: AbortSignal; timeout?: number; maxRetries?: number }) => {
      requests.push({ model: params.model, ...options })
      return Promise.resolve({
        id: 'reflection-fixture', object: 'chat.completion', created: 1, model: params.model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ knowledge: [
          { content: 'short' },
          { content: 'Check generated imports before accepting a failed build', tags: ['build', 123], confidence: 1 },
          { content: 'Keep verification evidence linked to the current run', confidence: -1 },
          { content: 'Preserve the actual failure when recording reusable knowledge' },
          { content: 'This fourth valid entry exceeds the per-run knowledge cap' },
        ] }), refusal: null } }],
      })
    } } },
  } as unknown as OpenAI
  return { directory, client, requests, semantic: new SemanticMemory(directory), episodic: new EpisodicMemory(directory) }
}

it('persists bounded run knowledge with failure provenance and the active cancellation signal', async () => {
  const test = fixture()
  const controller = new AbortController()
  const module = new ReflectionModule(test.client, 'old-model', test.semantic, {})
  await module.onComplete({
    cwd: test.directory,
    model: 'current-model',
    abortSignal: controller.signal,
    turnResult: { stopped: true, reason: 'error', status: 'failed', output: 'Build failed' },
    messages: [1, 2, 3].map(index => ({ role: 'tool', tool_call_id: String(index), content: 'Build failed' })),
  })
  expect(test.requests).toEqual([{ model: 'current-model', signal: controller.signal, timeout: 30_000, maxRetries: 0 }])
  const entries = test.semantic.readAll()
  expect(entries).toHaveLength(3)
  expect(entries.map(entry => entry.confidence)).toEqual([0.9, 0.5, 0.5])
  expect(entries[0].tags).toEqual(['build'])
  for (const entry of entries) {
    expect(entry.source).toBe('agent_inferred')
    expect(entry.content).toMatch(/^\[run failed; verification not_run\]/)
    expect(entry.provenance).toMatchObject({ status: 'unverified', claimedSource: 'agent_inferred', outcome: 'failed', verification: 'not_run' })
  }
})

it('consolidates partial sessions with distinct source attribution and persisted entry counts', async () => {
  const test = fixture()
  const controller = new AbortController()
  for (let index = 0; index < 5; index++) await test.episodic.writeAsync({
    turn: index, toolName: 'Read', inputSummary: 'input', resultSummary: 'result',
    outcome: index === 0 ? 'partial' : 'success', timestamp: new Date().toISOString(),
  })
  expect(await consolidateSession(test.client, 'session-model', test.episodic, test.semantic, undefined, controller.signal)).toEqual({ episodes: 5, knowledgeExtracted: 3 })
  expect(test.requests).toEqual([{ model: 'session-model', signal: controller.signal, timeout: 30_000, maxRetries: 0 }])
  for (const entry of test.semantic.readAll()) {
    expect(entry.source).toBe('consolidation')
    expect(entry.content).toMatch(/^\[session contains_failures_or_incomplete_actions; verification not_run\]/)
    expect(entry.provenance).toMatchObject({ status: 'unverified', claimedSource: 'consolidation', outcome: 'contains_failures_or_incomplete_actions', verification: 'not_run' })
  }
})
