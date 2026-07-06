import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { SemanticMemory } from '../src/core/semanticMemory.js'
import { EpisodicMemory } from '../src/core/episodicMemory.js'
import { ModuleRegistry } from '../src/core/moduleRegistry.js'
import type { AgentModule, ModuleBootResult, ModuleContext } from '../src/core/module.js'

// ── SemanticMemory ───────────────────────────────────────────────────────────

describe('SemanticMemory', () => {
  let tmpDir: string
  let mem: SemanticMemory

  beforeEach(() => {
    tmpDir = join(process.cwd(), '.test-mem-' + Date.now())
    mkdirSync(join(tmpDir, 'memory'), { recursive: true })
    mem = new SemanticMemory(tmpDir)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes and reads back entries', () => {
    const entry = mem.write({
      content: 'Always use tabs not spaces',
      tags: ['convention'],
      source: 'user_stated',
      confidence: 0.9,
      timestamp: new Date().toISOString(),
    })
    expect(entry.id).toBeTruthy()
    expect(mem.readAll()).toHaveLength(1)
  })

  it('deduplicates by content hash', () => {
    mem.write({ content: 'Use tabs not spaces', tags: [], source: 'user_stated', confidence: 0.9, timestamp: '' })
    mem.write({ content: 'Use tabs not spaces', tags: [], source: 'user_stated', confidence: 0.8, timestamp: '' })
    expect(mem.readAll()).toHaveLength(1)
    // Higher confidence wins
    expect(mem.readAll()[0].confidence).toBe(0.9)
  })

  it('source priority: user_stated overrides agent_inferred', () => {
    // Write agent_inferred first
    mem.write({ content: 'Deploy on Fridays is fine', tags: [], source: 'agent_inferred', confidence: 0.9, timestamp: '' })
    // Try to override with tool_observed (lower priority) — should NOT override
    mem.write({ content: 'Deploy on Fridays is fine', tags: [], source: 'tool_observed', confidence: 1.0, timestamp: '' })
    expect(mem.readAll()).toHaveLength(1)
    expect(mem.readAll()[0].source).toBe('agent_inferred')
  })

  it('source priority: user_stated overrides existing agent_inferred', () => {
    mem.write({ content: 'Use pnpm', tags: [], source: 'agent_inferred', confidence: 0.5, timestamp: '' })
    mem.write({ content: 'Use pnpm', tags: [], source: 'user_stated', confidence: 0.9, timestamp: '' })
    expect(mem.readAll()).toHaveLength(1)
    expect(mem.readAll()[0].source).toBe('user_stated')
  })

  it('searches by keywords', () => {
    mem.write({ content: 'TypeScript strict mode is recommended', tags: ['ts'], source: 'agent_inferred', confidence: 0.8, timestamp: '' })
    mem.write({ content: 'Use ESLint for linting', tags: ['lint'], source: 'agent_inferred', confidence: 0.7, timestamp: '' })
    const results = mem.search({ keywords: ['typescript'] })
    expect(results).toHaveLength(1)
    expect(results[0].content).toContain('TypeScript')
  })

  it('searches by tags', () => {
    mem.write({ content: 'entry1', tags: ['security'], source: 'agent_inferred', confidence: 0.8, timestamp: '' })
    mem.write({ content: 'entry2', tags: ['performance'], source: 'agent_inferred', confidence: 0.8, timestamp: '' })
    const results = mem.search({ tags: ['security'] })
    expect(results).toHaveLength(1)
    expect(results[0].tags).toContain('security')
  })

  it('persists to disk and reloads', () => {
    mem.write({ content: 'persisted entry', tags: ['test'], source: 'user_stated', confidence: 0.9, timestamp: '' })
    const mem2 = new SemanticMemory(tmpDir)
    expect(mem2.readAll()).toHaveLength(1)
    expect(mem2.readAll()[0].content).toBe('persisted entry')
  })
})

// ── EpisodicMemory ───────────────────────────────────────────────────────────

describe('EpisodicMemory', () => {
  let tmpDir: string
  let mem: EpisodicMemory

  beforeEach(() => {
    tmpDir = join(process.cwd(), '.test-epi-' + Date.now())
    mkdirSync(join(tmpDir, 'memory'), { recursive: true })
    mem = new EpisodicMemory(tmpDir)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes and reads episodes', () => {
    mem.write({ turn: 1, toolName: 'Bash', inputSummary: 'ls', resultSummary: 'file1.ts', outcome: 'success', timestamp: '' })
    mem.write({ turn: 2, toolName: 'Read', inputSummary: 'file1.ts', resultSummary: 'contents', outcome: 'success', timestamp: '' })
    const recent = mem.recent(10)
    expect(recent).toHaveLength(2)
  })

  it('filters by tool name', () => {
    mem.write({ turn: 1, toolName: 'Bash', inputSummary: '', resultSummary: '', outcome: 'success', timestamp: '' })
    mem.write({ turn: 2, toolName: 'Read', inputSummary: '', resultSummary: '', outcome: 'success', timestamp: '' })
    mem.write({ turn: 3, toolName: 'Bash', inputSummary: '', resultSummary: '', outcome: 'failure', timestamp: '' })
    const bashOnly = mem.findByTool('Bash')
    expect(bashOnly).toHaveLength(2)
  })

  it('returns limited recent episodes', () => {
    for (let i = 0; i < 20; i++) {
      mem.write({ turn: i, toolName: 'Bash', inputSummary: '', resultSummary: '', outcome: 'success', timestamp: '' })
    }
    expect(mem.recent(5)).toHaveLength(5)
  })
})

// ── ModuleRegistry ───────────────────────────────────────────────────────────

describe('ModuleRegistry', () => {
  function makeModule(name: string, deps?: string[]): AgentModule {
    return {
      name,
      dependencies: deps,
      boot: (): ModuleBootResult => ({}),
    }
  }

  function makeCtx(): ModuleContext {
    return {
      client: {} as never,
      model: 'test',
      config: {} as never,
    }
  }

  it('resolves modules by name', () => {
    const reg = new ModuleRegistry()
    reg.register('a', () => makeModule('a'))
    const modules = reg.resolve(['a'], makeCtx())
    expect(modules).toHaveLength(1)
    expect(modules[0].name).toBe('a')
  })

  it('resolves dependencies before dependents', () => {
    const reg = new ModuleRegistry()
    reg.register('child', () => makeModule('child', ['parent']))
    reg.register('parent', () => makeModule('parent'))
    const modules = reg.resolve(['child'], makeCtx())
    // parent should come first (resolved as dependency)
    expect(modules).toHaveLength(2)
    expect(modules[0].name).toBe('parent')
    expect(modules[1].name).toBe('child')
  })

  it('deduplicates when same module requested twice', () => {
    const reg = new ModuleRegistry()
    reg.register('a', () => makeModule('a'))
    reg.register('b', () => makeModule('b', ['a']))
    const modules = reg.resolve(['a', 'b'], makeCtx())
    expect(modules).toHaveLength(2) // a appears once
  })

  it('detects circular dependencies without crashing', () => {
    const reg = new ModuleRegistry()
    reg.register('x', () => makeModule('x', ['y']))
    reg.register('y', () => makeModule('y', ['x']))
    // Should not stack-overflow — cycle detection stops recursion
    const modules = reg.resolve(['x'], makeCtx())
    // Each module appears at most once
    expect(modules.length).toBeLessThanOrEqual(2)
  })

  it('returns empty for unknown modules', () => {
    const reg = new ModuleRegistry()
    const modules = reg.resolve(['nonexistent'], makeCtx())
    expect(modules).toHaveLength(0)
  })

  it('has() checks registration', () => {
    const reg = new ModuleRegistry()
    reg.register('a', () => makeModule('a'))
    expect(reg.has('a')).toBe(true)
    expect(reg.has('b')).toBe(false)
  })
})
