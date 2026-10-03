import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PushNotificationTool } from '../../src/tools/pushNotification.js'
import type * as ChildProcess from 'child_process'

const nativeRequests = vi.hoisted(() => [] as Array<{ executable: string; args: string[] }>)
const nativeBehavior = vi.hoisted(() => ({ fail: false }))
vi.mock('child_process', async importOriginal => {
  const original = await importOriginal<typeof ChildProcess>()
  return {
    ...original,
    execSync: () => Buffer.from(''),
    execFileSync: (executable: string, args: string[]) => {
      nativeRequests.push({ executable, args })
      if (nativeBehavior.fail) throw new Error('native notification unavailable')
      return Buffer.from('')
    },
  }
})
beforeEach(() => { nativeRequests.length = 0; nativeBehavior.fail = false })

describe('notification subprocess arguments', () => {
  it('rejects non-string notification fields without throwing', async () => {
    await expect(new PushNotificationTool().execute({ title: 42, message: 'done' }, { cwd: process.cwd(), permissionMode: 'auto' })).resolves.toMatchObject({ isError: true })
  })

  it('passes notification text through a native argument list', async () => {
    const result = await new PushNotificationTool().execute({ title: 'Build complete', message: 'Text with "quotes" and $(characters)' }, { cwd: process.cwd(), permissionMode: 'auto' })
    expect(result.isError).toBe(false)
    expect(nativeRequests).toHaveLength(1)
    expect(nativeRequests[0].args.join(' ')).toContain('Build complete')
  })

  it('reports failure when both native notification and terminal delivery fail', async () => {
    nativeBehavior.fail = true
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => { throw new Error('terminal unavailable') })
    try {
      const result = await new PushNotificationTool().execute({ title: 'Build complete', message: 'done' }, { cwd: process.cwd(), permissionMode: 'auto' })
      expect(result.isError).toBe(true)
      expect(result.content).toContain('Notification failed')
      expect(result.content).toContain('terminal unavailable')
      expect(result.content).not.toContain('Notification delivered')
    } finally {
      stderr.mockRestore()
    }
  })
})
