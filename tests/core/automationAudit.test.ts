import type OpenAI from 'openai'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { writeSampleWorkflow } from '../../src/core/workflow.js'
import { getBudgetPath, listBudgets, setBudget, recordUsage, getUsage } from '../../src/core/budget.js'
import { maybeCompact } from '../../src/core/compact.js'
import type { OpenAIMessage } from '../../src/core/types.js'

const directories: string[] = []
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'ovo-automation-audit-'))
  directories.push(path)
  return path
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

it.each(['../escape', '..\\escape'])('rejects workflow filename traversal %s before creating files', name => {
  const cwd = directory()
  expect(() => writeSampleWorkflow(cwd, name)).toThrow(/name/i)
  expect(existsSync(join(cwd, '.ovolv999', 'escape.json'))).toBe(false)
  expect(existsSync(join(cwd, '.ovolv999', 'workflows'))).toBe(false)
})

it('reads only valid budget records from malformed persisted structures without changing bytes', () => {
  const cwd = directory()
  const valid = { name: 'valid', type: 'cost', period: 'daily', limit: 10, enforced: true, warningThreshold: 0.8, enabled: true }
  mkdirSync(join(cwd, '.ovolv999'))
  const bytes = JSON.stringify({ budgets: { valid, broken: null, bad: { ...valid, name: 'bad', period: 'forever' } }, usage: null, resets: [] })
  writeFileSync(getBudgetPath(cwd), bytes)
  expect(listBudgets(cwd)).toEqual([valid])
  expect(getUsage(cwd, 'valid')?.spent).toBe(0)
  expect(readFileSync(getBudgetPath(cwd), 'utf8')).toBe(bytes)
  writeFileSync(getBudgetPath(cwd), 'null')
  expect(listBudgets(cwd)).toEqual([])
})

it.each([-1, NaN, Infinity])('rejects invalid usage amount %s without reducing or corrupting spending', amount => {
  const cwd = directory()
  setBudget(cwd, { name: 'tokens', type: 'tokens', period: 'session', limit: 10 })
  recordUsage(cwd, 'tokens', 8)
  const bytes = readFileSync(getBudgetPath(cwd), 'utf8')
  expect(() => recordUsage(cwd, 'tokens', amount)).toThrow(/amount/i)
  expect(readFileSync(getBudgetPath(cwd), 'utf8')).toBe(bytes)
  expect(getUsage(cwd, 'tokens')?.spent).toBe(8)
})

it('rejects invalid budget limits before persisting them', () => {
  const cwd = directory()
  expect(() => setBudget(cwd, { name: 'broken', type: 'tokens', period: 'session', limit: NaN })).toThrow(/budget/i)
  expect(existsSync(getBudgetPath(cwd))).toBe(false)
})

it.each(['__proto__', 'constructor'])('persists a budget named %s without confusing object inheritance', name => {
  const cwd = directory()
  setBudget(cwd, { name, type: 'requests', period: 'session', limit: 2 })
  recordUsage(cwd, name, 1)
  expect(listBudgets(cwd).map(budget => budget.name)).toEqual([name])
  expect(getUsage(cwd, name)?.spent).toBe(1)
})

it.each(['length', 'content_filter'])('retains complete history when a summary ends with %s', async finish_reason => {
  const messages: OpenAIMessage[] = Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'Original message ' + index }))
  const before = structuredClone(messages)
  const client = { chat: { completions: { create: () => Promise.resolve({ choices: [{ finish_reason, message: { content: '<summary>partial content</summary>' } }] }) } } } as unknown as OpenAI
  const result = await maybeCompact(client, 'test-model', messages)
  expect(result.compacted).toBe(false)
  expect(result.messages).toBe(messages)
  expect(messages).toEqual(before)
})
