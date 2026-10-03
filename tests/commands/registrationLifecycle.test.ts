import { afterEach, describe, expect, it } from 'vitest'
import { clearRegistry, getCommand, registerCommand } from '../../src/commands/index.js'
afterEach(() => clearRegistry())
describe('command registration lifecycle', () => {
  it('removes obsolete aliases when the same command is registered again', () => {
    registerCommand({ name: 'fixture', aliases: ['old-alias'], description: 'old', handler: () => ({ type: 'noop' }) })
    registerCommand({ name: 'fixture', aliases: ['new-alias'], description: 'new', handler: () => ({ type: 'noop' }) })
    expect(getCommand('old-alias')).toBeUndefined()
    expect(getCommand('new-alias')?.description).toBe('new')
  })
  it('keeps an alias claimed by a different command during re-registration', () => {
    registerCommand({ name: 'first', aliases: ['shared'], description: 'first', handler: () => ({ type: 'noop' }) })
    registerCommand({ name: 'second', aliases: ['shared'], description: 'second', handler: () => ({ type: 'noop' }) })
    registerCommand({ name: 'first', aliases: [], description: 'first updated', handler: () => ({ type: 'noop' }) })
    expect(getCommand('shared')?.description).toBe('second')
  })
})
