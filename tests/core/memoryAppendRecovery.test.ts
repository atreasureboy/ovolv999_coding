import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SemanticMemory } from '../../src/core/semanticMemory.js'
import { EpisodicMemory } from '../../src/core/episodicMemory.js'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

it.each(['sync', 'async'] as const)('keeps semantic appends readable after a torn tail using %s writes', async mode => {
  const directory = mkdtempSync(join(tmpdir(), 'ovo-memory-append-'))
  directories.push(directory)
  const memory = new SemanticMemory(directory)
  const entry = { content: 'Keep the original preference', tags: ['preference'], source: 'user_stated', confidence: 0.9, timestamp: '' }
  const original = memory.write(entry)
  const file = join(directory, 'memory', 'semantic.jsonl')
  const prior = readFileSync(file, 'utf8') + '{"id":"partial'
  writeFileSync(file, prior)
  const next = { ...entry, content: 'Keep the new preference' }
  const result = mode === 'sync' ? memory.write(next) : await memory.writeAsync(next)
  expect(result.persistence).toBe('persisted')
  expect(new SemanticMemory(directory).readAll().map(row => row.id)).toEqual([original.id, result.id])
  expect(readFileSync(file, 'utf8')).toContain(prior + '\n')
})

it.each(['sync', 'async'] as const)('keeps episodic appends readable after a torn tail using %s writes', async mode => {
  const directory = mkdtempSync(join(tmpdir(), 'ovo-memory-append-'))
  directories.push(directory)
  const memory = new EpisodicMemory(directory)
  const entry = { turn: 1, toolName: 'Read', inputSummary: 'fixture.txt', resultSummary: 'read', outcome: 'success' as const, timestamp: '' }
  const original = memory.write(entry)
  const file = join(directory, 'memory', 'episodes.jsonl')
  const prior = readFileSync(file, 'utf8') + '{"id":"partial'
  writeFileSync(file, prior)
  const next = { ...entry, turn: 2 }
  const result = mode === 'sync' ? memory.write(next) : await memory.writeAsync(next)
  expect(result.persistence).toBe('persisted')
  expect(new EpisodicMemory(directory).readAll().map(row => row.id)).toEqual([original.id, result.id])
  expect(readFileSync(file, 'utf8')).toContain(prior + '\n')
})

it.each(['semantic', 'episodic'] as const)('preserves a complete final %s record without a newline before appending', async kind => {
  const directory = mkdtempSync(join(tmpdir(), 'ovo-memory-append-'))
  directories.push(directory)
  const semantic = new SemanticMemory(directory)
  const episodic = new EpisodicMemory(directory)
  const semanticEntry = { content: 'Original', tags: [], source: 'user_stated', confidence: 0.9, timestamp: '' }
  const episodeEntry = { turn: 1, toolName: 'Read', inputSummary: '', resultSummary: '', outcome: 'success' as const, timestamp: '' }
  const original = kind === 'semantic' ? semantic.write(semanticEntry) : episodic.write(episodeEntry)
  const file = join(directory, 'memory', kind === 'semantic' ? 'semantic.jsonl' : 'episodes.jsonl')
  writeFileSync(file, readFileSync(file, 'utf8').trimEnd())
  const result = kind === 'semantic' ? await semantic.writeAsync({ ...semanticEntry, content: 'New' }) : await episodic.writeAsync({ ...episodeEntry, turn: 2 })
  expect(result.persistence).toBe('persisted')
  const rows = kind === 'semantic' ? new SemanticMemory(directory).readAll() : new EpisodicMemory(directory).readAll()
  expect(rows.map(row => row.id)).toEqual([original.id, result.id])
})
