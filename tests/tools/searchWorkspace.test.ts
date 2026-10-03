import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ToolContext } from '../../src/core/types.js'
import { GlobTool } from '../../src/tools/glob.js'
import { GrepTool } from '../../src/tools/grep.js'

let root: string
let cwd: string
let outside: string
let context: ToolContext

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'search-workspace-'))
  cwd = join(root, 'child')
  outside = join(root, 'outside')
  mkdirSync(join(cwd, 'nested'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(cwd, 'nested/inside.txt'), 'inside needle')
  writeFileSync(join(outside, 'outside.txt'), 'outside secret needle')
  context = { cwd, permissionMode: 'auto', workspaceBound: true }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('search workspace and failure behavior', () => {
  it('resolves a relative Glob path against the tool workspace', async () => {
    const result = await new GlobTool().execute({ pattern: '*.txt', path: 'nested' }, context)
    expect(result.isError).toBe(false)
    expect(result.content).toContain('inside.txt')
  })

  it.each([new GlobTool(), new GrepTool()])('$name rejects a delegated path escape', async tool => {
    const result = await tool.execute({ pattern: tool.name === 'Glob' ? '*.txt' : 'needle', path: outside }, context)
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/outside.*workspace/i)
    expect(result.content).not.toContain('outside secret')
  })

  it('rejects an absolute Glob pattern outside the delegated workspace', async () => {
    const result = await new GlobTool().execute({ pattern: join(outside, '*.txt') }, context)
    expect(result.isError).toBe(true)
  })

  it('Grep reports an invalid regex as an error', async () => {
    const result = await new GrepTool().execute({ pattern: '[' }, context)
    expect(result.isError).toBe(true)
    expect(result.content).not.toContain('No matches found')
  })

  it('Grep honors a pre-aborted request', async () => {
    const abort = new AbortController()
    abort.abort()
    context.signal = abort.signal
    const result = await new GrepTool().execute({ pattern: 'needle' }, context)
    expect(result.isError).toBe(true)
  })
})
