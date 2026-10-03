import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SemanticMemory } from '../../src/core/semanticMemory.js'

const directories: string[] = []

function memory() {
  const directory = mkdtempSync(join(tmpdir(), 'ovo-memory-index-'))
  directories.push(directory)
  return { directory, memory: new SemanticMemory(directory) }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function entry(source: string, tags = ['test']) {
  return { content: 'Use verified evidence', tags, source, confidence: 0.8, timestamp: '' }
}

describe('semantic memory indexes', () => {
  it.each(['constructor', '__proto__', 'toString'])(
    'persists and searches the literal tag %s',
    (tag) => {
      const { directory, memory: semantic } = memory()
      const saved = semantic.write(entry('user_stated', [tag]))
      expect(saved.persistence).toBe('persisted')
      expect(semantic.search({ tags: [tag] })).toHaveLength(1)
      expect(new SemanticMemory(directory).search({ tags: [tag] })[0]).toMatchObject({
        id: saved.id,
        tags: [tag],
      })
    },
  )

  it.each(['constructor', '__proto__', 'toString'])(
    'ranks unknown source %s below a user source',
    (source) => {
      const { memory: semantic } = memory()
      const saved = semantic.write(entry('user_stated'))
      expect(semantic.write(entry(source))).toMatchObject({
        id: saved.id,
        source: 'user_stated',
        persistence: 'persisted',
      })
      expect(semantic.readAll()).toHaveLength(1)
    },
  )
})
