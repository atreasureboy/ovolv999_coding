import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { expect, it, vi } from 'vitest'
import type * as ExecutionApi from '../../src/core/executionBackend.js'
import type * as TreeApi from '../../src/core/processTree.js'

const state = vi.hoisted(() => ({ process: null as EventEmitter | null }))

vi.mock('../../src/core/executionBackend.js', async importOriginal => {
  const original = await importOriginal<typeof ExecutionApi>()
  return { ...original, spawnManaged: () => state.process }
})

vi.mock('../../src/core/processIdentity.js', () => ({ inspectProcessIdentity: () => Promise.resolve('dead') }))

vi.mock('../../src/core/processTree.js', async importOriginal => {
  const original = await importOriginal<typeof TreeApi>()
  const root = { pid: 1042, hostname: 'test', birthId: 'known-root' }
  return {
    ...original,
    captureOwnedProcessTreeFromPid: () => Promise.reject(new original.OwnedProcessTreeCaptureError('Partial descendant identities', { root, members: [root], detached: false }, true)),
    stopOwnedProcessTree: () => Promise.resolve({ stopped: true, remaining: [] }),
  }
})

import { BackgroundTaskManager } from '../../src/core/backgroundTaskManager.js'
import { createProcessScope } from '../../src/core/executionBackend.js'

for (const action of ['close', 'stop'] as const) {
  it(`retains physical ownership when a partial descendant snapshot precedes ${action}`, async () => {
    const child = Object.assign(new EventEmitter(), { pid: 1042, exitCode: null as number | null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough() })
    state.process = child
    const manager = new BackgroundTaskManager({ sigkillGraceMs: 0 })
    const scope = createProcessScope()
    try {
      const id = await scope.run(() => Promise.resolve(manager.createTask('fixture')))
      await vi.waitFor(() => expect(manager.getTask(id)?.metadata.discoveryError).toBe('Partial descendant identities'))
      if (action === 'close') {
        child.exitCode = 0
        child.emit('close', 0)
      } else {
        expect(manager.stopTask(id)).toBe(true)
      }
      const result = await manager.waitForTask(id, 1000)
      expect({ status: result?.status, pending: scope.pending.size }).toEqual({ status: 'stop_failed', pending: 1 })
      await expect(manager.dispose()).rejects.toThrow('termination unconfirmed')
    } finally {
      child.emit('close', 0)
      child.stdout.destroy()
      child.stderr.destroy()
      await manager.dispose().catch(() => {})
      state.process = null
    }
  })
}
