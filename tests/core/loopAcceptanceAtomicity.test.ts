import { expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runLoop } from '../../src/core/loopEngine.js'
import { withWorkspaceAccess } from '../../src/core/runContext.js'
import * as verification from '../../src/core/verification.js'
import { loopFixture } from '../fixtures/loopClient.js'
import type { LoopState } from '../../src/core/autonomy/types.js'

it('persists receipt and authoritative checkpoint before yielding the workspace to a queued writer', async () => {
  const f = await loopFixture()
  writeFileSync(join(f.cwd, 'artifact.txt'), 'verified version')
  let writer: Promise<void> | undefined
  let receipt: { taskId: string; checkpointRevision: number } | undefined
  let checkpoint: LoopState | undefined
  const execute = verification.executeVerification
  vi.spyOn(verification, 'executeVerification').mockImplementation(async options => {
    writer = withWorkspaceAccess(f.cwd, 'queued-writer', true, new AbortController().signal, async assertOwned => {
      assertOwned()
      receipt = JSON.parse(readFileSync(join(f.loopDir, 'DONE.flag'), 'utf8')) as typeof receipt
      checkpoint = JSON.parse(readFileSync(join(f.sessionDir, 'loop-controller', 'state.json'), 'utf8')) as LoopState
      writeFileSync(join(f.cwd, 'artifact.txt'), 'unverified version')
    })
    return execute(options)
  })
  try {
    const result = await runLoop(f.client, f.renderer, f.config)
    await writer
    expect(result.status).toBe('completed')
    expect(receipt!.taskId).toBe(checkpoint!.taskId)
    expect(receipt!.checkpointRevision).toBe(checkpoint!.revision)
    expect(checkpoint!.current?.checkpoint?.decision).toMatchObject({ action: 'stop', status: 'completed' })
  } finally { vi.restoreAllMocks(); await writer; await f.close(); vi.unstubAllEnvs() }
})
