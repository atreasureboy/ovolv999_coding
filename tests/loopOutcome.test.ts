import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { runLoop } from '../src/core/loopEngine.js'
import { loopFixture, reply } from './fixtures/loopClient.js'

const fixtures: Awaited<ReturnType<typeof loopFixture>>[] = []
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); vi.unstubAllEnvs() })
async function setup(options: Parameters<typeof loopFixture>[0] = {}) { const f = await loopFixture(options); fixtures.push(f); return f }

it('rejects an empty acceptance definition even with a forged completion marker', async () => {
  const f = await setup({ acceptance: '' })
  writeFileSync(join(f.loopDir, 'DONE.flag'), 'done')
  const result = await runLoop(f.client, f.renderer, f.config)
  expect(result.status).toBe('blocked')
  expect(result.verification.status).toBe('not_applicable')
  expect(f.requests).toHaveLength(0)
})

it.each(['GOAL.md', 'ACCEPTANCE.md'])('blocks an agent that rewrites frozen %s and forges DONE', async name => {
  const f = await setup({ respond: (_index, res, cwd) => {
    writeFileSync(join(cwd, '.loop', name), '- [x] A1: rewritten `node -e "process.exit(0)"`')
    writeFileSync(join(cwd, '.loop', 'DONE.flag'), 'accepted')
    reply(res)
  } })
  const result = await runLoop(f.client, f.renderer, f.config)
  expect(result.status).toBe('blocked')
  expect(result.outcomeReason?.code).toBe('acceptance_invalidated')
  expect(f.requests).toHaveLength(1)
})

it('executes frozen failing acceptance despite an existing DONE marker', async () => {
  const f = await setup({ check: "require('fs').writeFileSync('../checked.txt','yes'); process.exit(1)" })
  writeFileSync(join(f.loopDir, 'DONE.flag'), 'completed in a previous run')
  const result = await runLoop(f.client, f.renderer, { ...f.config, maxIters: 1 })
  expect(existsSync(join(f.base, 'checked.txt'))).toBe(true)
  expect(result.status).toBe('limit_reached')
})
