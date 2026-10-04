import { describe, expect, it } from 'vitest'
import { UIStore } from '../../../src/ui/ink/store.js'

describe('overlay lifecycle', () => {
  it('does not apply a late callback from an older dialog to the next queued request', async () => {
    const store = new UIStore()
    const first = store.showPermissionDialog({ toolName: 'Bash', preview: 'first', riskLevel: 'needs-approval' })
    const second = store.showPermissionDialog({ toolName: 'Bash', preview: 'second', riskLevel: 'needs-approval' })
    const displayed = store.getState().pendingPermission!
    store.resolvePermission(true, false, undefined, 'once', undefined, displayed)
    await expect(first).resolves.toMatchObject({ approved: true })
    store.resolvePermission(true, false, undefined, 'once', undefined, displayed)
    expect(store.getState().pendingPermission?.preview).toBe('second')
    store.resolvePermission(false, false)
    await expect(second).resolves.toMatchObject({ approved: false })
  })

  it('queues three permission requests and settles each only once', async () => {
    const store = new UIStore()
    const settled: string[] = []
    const requests = ['first', 'second', 'third'].map((preview) =>
      store.showPermissionDialog({ toolName: 'Bash', preview, riskLevel: 'needs-approval' })
        .then((result) => { settled.push(preview); return result }),
    )
    expect(store.getState().pendingPermission?.preview).toBe('first')
    store.resolvePermission(true, false)
    expect(store.getState().pendingPermission?.preview).toBe('second')
    store.resolvePermission(false, false, 'Try a safer command')
    expect(store.getState().pendingPermission?.preview).toBe('third')
    store.resolvePermission(true, false)
    store.resolvePermission(false, false)
    expect(await Promise.all(requests)).toEqual([
      { approved: true, alwaysAllow: false, feedback: undefined },
      { approved: false, alwaysAllow: false, feedback: 'Try a safer command' },
      { approved: true, alwaysAllow: false, feedback: undefined },
    ])
    expect(settled).toEqual(['first', 'second', 'third'])
    expect(store.getState().pendingPermission).toBeNull()
  })

  it('cancels only the aborted queued permission and keeps the active request', async () => {
    const store = new UIStore()
    const controller = new AbortController()
    const first = store.showPermissionDialog({ toolName: 'Bash', preview: 'first', riskLevel: 'needs-approval' })
    const second = store.showPermissionDialog({ toolName: 'Bash', preview: 'second', riskLevel: 'needs-approval', signal: controller.signal })
    controller.abort()
    await expect(second).resolves.toMatchObject({ approved: false, alwaysAllow: false })
    expect(store.getState().pendingPermission?.preview).toBe('first')
    store.resolvePermission(true, false)
    await expect(first).resolves.toMatchObject({ approved: true })
  })

  it('denies every queued request on overlay cancellation exactly once', async () => {
    const store = new UIStore()
    const settled: string[] = []
    const pending = ['one', 'two', 'three'].map((preview) =>
      store.showPermissionDialog({ toolName: 'Bash', preview, riskLevel: 'needs-approval' }).then((result) => { settled.push(preview); return result }),
    )
    store.cancelOverlays()
    store.cancelOverlays()
    expect((await Promise.all(pending)).map((result) => result.approved)).toEqual([false, false, false])
    expect(settled).toEqual(['one', 'two', 'three'])
    expect(store.hasOverlay()).toBe(false)
  })

  it('settles an older approval when a new overlay replaces it', async () => {
    const store = new UIStore()
    const first = store.showPlanApproval('Earlier plan')
    const permission = store.showPermissionDialog({ toolName: 'Bash', preview: 'build', riskLevel: 'needs-approval' })
    expect(store.getState().pendingPlan).toBeNull()
    await expect(first).resolves.toBe(false)
    store.resolvePermission(false, false)
    await expect(permission).resolves.toEqual({ approved: false, alwaysAllow: false, feedback: undefined })
  })
})
