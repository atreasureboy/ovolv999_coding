import { expect, it } from 'vitest'
import { CtxInspectTool } from '../../src/tools/ctxInspect.js'

const context = {
  cwd: process.cwd(), permissionMode: 'auto' as const,
  getMessages: () => [
    { role: 'user' as const, content: 'one' },
    { role: 'assistant' as const, content: 'two'.repeat(20) },
    { role: 'user' as const, content: 'three'.repeat(50) },
  ],
}

it.each([-1, 0, 1.5, Number.NaN, Infinity, '2', null])('rejects an invalid largest-message limit %s', async top_n => {
  const result = await new CtxInspectTool().execute({ action: 'largest', top_n }, context)
  expect(result.isError).toBe(true)
  expect(result.content).toContain('top_n')
})

it('returns exactly the requested positive integer number of largest messages', async () => {
  const result = await new CtxInspectTool().execute({ action: 'largest', top_n: 2 }, context)
  expect(result.isError).toBe(false)
  expect(result.content).toContain('Top 2 largest messages:')
  expect((result.content.match(/^ {2}#/gm) ?? []).length).toBe(2)
})
