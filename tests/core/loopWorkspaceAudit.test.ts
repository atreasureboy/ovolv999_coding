import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { runLoop } from '../../src/core/loopEngine.js'
import { quarantineWorkspace, withWorkspaceAccess } from '../../src/core/runContext.js'
import * as verification from '../../src/core/verification.js'
import { loopFixture } from '../fixtures/loopClient.js'

const fixtures: Awaited<ReturnType<typeof loopFixture>>[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) await f.close(); vi.unstubAllEnvs() })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(accept => { resolve = accept }); return { promise, resolve } }
async function setup() { const f = await loopFixture({ check: "require('fs').writeFileSync('../checked.txt', 'checked')" }); fixtures.push(f); return f }

it('waits for workspace ownership before hashing and running loop checks', async () => {
  const f = await setup()
  const entered = deferred(), released = deferred()
  const holder = withWorkspaceAccess(f.cwd, 'other-family', true, new AbortController().signal, async () => { entered.resolve(); await released.promise })
  await entered.promise
  const capture = vi.spyOn(verification, 'captureArtifactVersion')
  const pending = runLoop(f.client, f.renderer, f.config)
  let settled = false
  void pending.then(() => { settled = true })
  try {
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(capture).not.toHaveBeenCalled()
    expect(existsSync(join(f.base, 'checked.txt'))).toBe(false)
    expect(settled).toBe(false)
  } finally { released.resolve(); await holder }
  expect((await pending).status).toBe('completed')
  expect(existsSync(join(f.base, 'checked.txt'))).toBe(true)
})

it('blocks loop verification in a quarantined workspace before starting commands', async () => {
  const f = await setup(), unsettled = deferred()
  quarantineWorkspace(f.cwd, unsettled.promise)
  try {
    const result = await runLoop(f.client, f.renderer, f.config)
    expect(result.status).toBe('blocked')
    expect(existsSync(join(f.base, 'checked.txt'))).toBe(false)
  } finally { unsettled.resolve(); await unsettled.promise }
})
