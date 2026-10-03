import { describe, expect, it } from 'vitest'
import { UIStore } from '../../../src/ui/ink/store.js'

describe('overlay lifecycle', () => {
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
