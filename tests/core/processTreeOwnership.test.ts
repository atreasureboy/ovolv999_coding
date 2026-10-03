import { expect, it } from 'vitest'
import { mergeOwnedProcessTrees, selectOwnedProcessMembers } from '../../src/core/processTree.js'
import type { ProcessIdentity } from '../../src/core/processIdentity.js'

const identity = (pid: number, birthId: string): ProcessIdentity => ({ pid, birthId, hostname: 'fixture-host' })

it.each(['', 'boot:'])('excludes stale parent PID relationships and their descendants for %s birth identities', prefix => {
  const root = identity(10, `${prefix}200`)
  const stale = identity(20, `${prefix}100`)
  const staleChild = identity(30, `${prefix}300`)
  const child = identity(40, `${prefix}210`)
  const staleGrandchild = identity(50, `${prefix}205`)
  const grandchild = identity(60, `${prefix}220`)
  expect(selectOwnedProcessMembers(root, [
    { identity: stale, parentPid: root.pid },
    { identity: staleChild, parentPid: stale.pid },
    { identity: child, parentPid: root.pid },
    { identity: staleGrandchild, parentPid: child.pid },
    { identity: grandchild, parentPid: child.pid },
  ])).toEqual([root, child, grandchild])
})

it('rejects merging a new process that reused an owned root PID', () => {
  const root = identity(10, '200')
  const replacement = identity(10, '300')
  const original = { root, members: [root, identity(20, '210')], detached: true }
  expect(() => mergeOwnedProcessTrees(original, { root: replacement, members: [replacement, identity(30, '310')], detached: true })).toThrow(/root identity changed/)
  expect(original.members).toEqual([root, identity(20, '210')])
})
