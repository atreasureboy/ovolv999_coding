import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SemanticMemory } from '../../src/core/semanticMemory.js'

const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })

it('skips invalid semantic metadata before sorting while preserving valid legacy rows', () => {
  const path = mkdtempSync(join(tmpdir(), 'semantic-schema-'))
  directories.push(path)
  mkdirSync(join(path, 'memory'))
  const valid = { id: 'legacy', content: 'Preserve valid legacy memory', tags: ['rule'], source: 'user_stated', timestamp: '', confidence: 0.9 }
  const invalid = [null, { ...valid, id: 'bad-source', source: 1 }, { ...valid, id: 'bad-confidence', confidence: '0.9' }, { id: 'missing-time', content: 'Missing timestamp', tags: [], source: 'user_stated', confidence: 0.9 }, { ...valid, id: 'bad-range', confidence: 2 }]
  const bytes = [valid, ...invalid].map(value => JSON.stringify(value)).join('\n')
  const file = join(path, 'memory', 'semantic.jsonl')
  writeFileSync(file, bytes)
  const memory = new SemanticMemory(path)
  expect(memory.search({})).toMatchObject([valid])
  expect(readFileSync(file, 'utf8')).toBe(bytes)
  expect(memory.readAll()[0].provenance).toEqual({ status: 'unverified', claimedSource: 'user_stated' })
})

it('refuses to append invalid semantic metadata that cannot survive reload', () => {
  const path = mkdtempSync(join(tmpdir(), 'semantic-schema-'))
  directories.push(path)
  const memory = new SemanticMemory(path)
  const invalid = { content: 'Invalid memory confidence', tags: [], source: 'agent_inferred', timestamp: '', confidence: Number.NaN }
  expect(memory.write(invalid)).toMatchObject({ persistence: 'failed' })
  expect(new SemanticMemory(path).readAll()).toEqual([])
})
