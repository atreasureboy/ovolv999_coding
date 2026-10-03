import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { dream, getDreamDir, getDreamLog } from '../../src/core/autoDream.js'
import { addEntry, getKnowledgePath, loadKnowledge } from '../../src/core/knowledgeBase.js'
import { isSemanticMemoryEntry, SemanticMemory } from '../../src/core/semanticMemory.js'
import { RunStore } from '../../src/core/runStore.js'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'runtime-enum-audit-'))
  vi.stubEnv('HOME', directory)
  vi.stubEnv('USERPROFILE', directory)
})
afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }) })

it('preserves healthy dream rows beside non-coercible enum objects', () => {
  const healthy = dream('insight', 'category', 'healthy record')
  const path = join(getDreamDir(), 'dream-log.json')
  const bytes = JSON.stringify([{ ...healthy, type: { toString: 0 } }, healthy])
  writeFileSync(path, bytes)
  expect(getDreamLog()).toEqual([healthy])
  expect(readFileSync(path, 'utf8')).toBe(bytes)
})

it('preserves healthy knowledge rows beside non-coercible enum objects', () => {
  const healthy = addEntry(directory, 'general', 'healthy', 'record')
  const path = getKnowledgePath(directory)
  const bytes = JSON.stringify({ entries: [{ ...healthy, category: { toString: 0 } }, healthy] })
  writeFileSync(path, bytes)
  expect(loadKnowledge(directory).entries).toEqual([healthy])
  expect(readFileSync(path, 'utf8')).toBe(bytes)
})

it('returns false for a malformed provenance enum and preserves neighboring memory', () => {
  const memory = new SemanticMemory(directory)
  const healthy = memory.write({ content: 'healthy record', tags: ['audit'], source: 'user_stated', timestamp: '', confidence: 0.8 })
  const invalid = { ...healthy, id: 'broken', provenance: { status: { toString: 0 }, claimedSource: 'user_stated' } }
  const path = join(directory, 'memory', 'semantic.jsonl')
  const bytes = `${JSON.stringify(invalid)}\n${JSON.stringify(healthy)}\n`
  writeFileSync(path, bytes)
  expect(isSemanticMemoryEntry(invalid)).toBe(false)
  expect(memory.readAll().map(entry => entry.id)).toEqual([healthy.id])
  expect(readFileSync(path, 'utf8')).toBe(bytes)
})

it('reports corrupt RunStore metadata without coercing its enum or changing healthy records', () => {
  const store = new RunStore(directory, { runId: 'enum-audit', workspace: directory })
  const healthyBytes = readFileSync(store.path, 'utf8')
  const healthy = JSON.parse(healthyBytes) as Record<string, unknown>
  const bytes = JSON.stringify({ ...healthy, status: { toString: 0 } })
  writeFileSync(store.path, bytes)
  expect(() => RunStore.inspect(store.path)).toThrow(/Unsupported or corrupt RunStore/)
  expect(readFileSync(store.path, 'utf8')).toBe(bytes)
  writeFileSync(store.path, healthyBytes)
  expect(RunStore.inspect(store.path)).toMatchObject({ runId: 'enum-audit', status: 'running' })
})
