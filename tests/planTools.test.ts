import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { EnterPlanModeTool } from '../src/tools/enterPlanMode.js'
import { VerifyPlanExecutionTool } from '../src/tools/verifyPlanExecution.js'
import type { ToolContext } from '../src/core/types.js'

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: '/test', permissionMode: 'auto', ...overrides }
}

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'ovogo-plan-'))
}

const tmpDirs: string[] = []
function freshProject(): string {
  const d = tmpProject()
  tmpDirs.push(d)
  return d
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!
    try { rmSync(d, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
})

describe('EnterPlanModeTool', () => {
  const tool = new EnterPlanModeTool()

  it('has correct name and metadata', () => {
    expect(tool.name).toBe('EnterPlanMode')
    expect(tool.metadata.readOnly).toBe(true)
    expect(tool.metadata.concurrencySafe).toBe(true)
  })

  it('is concurrency-safe', () => {
    expect(tool.isConcurrencySafe?.()).toBe(true)
  })

  it('calls enterPlanMode callback and returns entered message (T1)', async () => {
    const mockEnter = vi.fn()
    const ctx = makeCtx({ enterPlanMode: mockEnter })
    const result = await tool.execute({}, ctx)
    expect(mockEnter).toHaveBeenCalledOnce()
    expect(result.isError).toBe(false)
    expect(result.content).toContain('Entered plan mode')
  })

  it('gracefully handles missing callback (sub-agent/piped mode)', async () => {
    const result = await tool.execute({}, makeCtx())
    expect(result.isError).toBe(false)
    expect(result.content).toContain('Entered plan mode')
  })

  it('returns error when callback throws', async () => {
    const mockEnter = vi.fn().mockImplementation(() => { throw new Error('engine crashed') })
    const ctx = makeCtx({ enterPlanMode: mockEnter })
    const result = await tool.execute({}, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('engine crashed')
  })
})

describe('VerifyPlanExecutionTool', () => {
  const tool = new VerifyPlanExecutionTool()

  it('has correct name and metadata', () => {
    expect(tool.name).toBe('VerifyPlanExecution')
    expect(tool.metadata.readOnly).toBe(false)
    expect(tool.metadata.longRunning).toBe(true)
  })

  it('is NOT concurrency-safe', () => {
    expect(tool.isConcurrencySafe?.()).toBe(false)
  })

  it('returns passed=true when build script succeeds (T3)', async () => {
    const cwd = freshProject()
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({
      scripts: { build: 'echo ok' },
    }), 'utf8')

    const result = await tool.execute({}, makeCtx({ cwd }))
    expect(result.isError).toBe(false)
    expect(result.content).toContain('All checks passed')
    expect(result.content).toContain('passed')
  })

  it('returns isError=true when build script fails (T4)', async () => {
    const cwd = freshProject()
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({
      scripts: { build: 'node -e "process.exit(1)"' },
    }), 'utf8')

    const result = await tool.execute({}, makeCtx({ cwd }))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Verification failed')
    expect(result.content).toContain('FAILED')
  })

  it('returns no-commands message in empty project (T5)', async () => {
    const cwd = freshProject()
    const result = await tool.execute({}, makeCtx({ cwd }))
    expect(result.isError).toBe(false)
    expect(result.content).toContain('No verification commands detected')
  })
})
