import { describe, expect, it } from 'vitest'
import { createCliPermissionManager } from '../bin/ovogogogo.js'

describe('CLI effective permissions', () => {
  it('preserves project ask mode in a non-Ink entry point', () => {
    const manager = createCliPermissionManager(undefined, 'ask')
    expect(manager.getMode()).toBe('default')
    expect(manager.check('Bash', { command: 'node change.js' }, true)).toBe('ask')
  })

  it('does not infer bypass from the absence of an interactive UI', () => {
    expect(createCliPermissionManager(undefined, undefined).getMode()).toBe('default')
  })

  it('preserves explicit auto and bypass settings while enforcing explicit deny rules', () => {
    const automatic = createCliPermissionManager(undefined, 'auto')
    expect(automatic.getMode()).toBe('bypassPermissions')
    const configured = createCliPermissionManager({ mode: 'bypassPermissions', rules: [{ toolName: 'Bash', ruleContent: '*', behavior: 'deny', source: 'user' }] }, 'ask')
    expect(configured.check('Bash', { command: 'node change.js' }, true)).toBe('deny')
  })
})
