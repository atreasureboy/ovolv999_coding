import { describe, expect, it } from 'vitest'
import { createSkillRuntime } from '../../src/skills/runtime.js'

describe('shared skill invocation runtime', () => {
  it('expands literal arguments and identifies the selected source', () => {
    const runtime = createSkillRuntime(new Map([['inspect', {
      name: 'inspect', description: 'Inspect', prompt: 'Inspect $ARGS twice: $ARGS',
      sourcePath: '/project/.ovogo/skills/inspect.md', tools: ['Read'],
    }]]))
    expect(runtime.resolveSkillInvocation('inspect', '  $& src  ', 'user')).toEqual({
      name: 'inspect', args: '$& src', prompt: 'Inspect $& src twice: $& src',
      sourcePath: '/project/.ovogo/skills/inspect.md', eligible: true, requiredTools: ['Read'], diagnostics: [],
    })
  })

  it('allows explicit user invocation while refusing model invocation of user-only skills', () => {
    const runtime = createSkillRuntime(new Map([['manual', {
      name: 'manual', description: 'Manual', prompt: 'Manual task', disableModelInvocation: true,
    }]]))
    expect(runtime.resolveSkillInvocation('manual', '', 'user').eligible).toBe(true)
    expect(runtime.resolveSkillInvocation('manual', '', 'model')).toMatchObject({ eligible: false, prompt: '' })
  })

  it('refuses user invocation when only model invocation is enabled', () => {
    const runtime = createSkillRuntime(new Map([['automatic', {
      name: 'automatic', description: 'Automatic', prompt: 'Model task', userInvocable: false,
    }]]))
    expect(runtime.resolveSkillInvocation('automatic', '', 'user').eligible).toBe(false)
    expect(runtime.resolveSkillInvocation('automatic', '', 'model').eligible).toBe(true)
  })

  it.each([
    { restrictedTools: ['Write'] },
    { permissionGrants: ['Bash'] },
    { unsupportedMetadata: ['context', 'model', 'hooks'] },
  ])('blocks unsupported execution policy with a readable diagnostic: %j', (metadata) => {
    const runtime = createSkillRuntime(new Map([['complex', { name: 'complex', description: 'Complex', prompt: 'Never execute', ...metadata }]]))
    const invocation = runtime.resolveSkillInvocation('complex', '', 'user')
    expect(invocation.eligible).toBe(false)
    expect(invocation.prompt).toBe('')
    expect(invocation.diagnostics.join('\n')).toMatch(/unsupported/i)
  })

  it('reports a missing skill without producing a prompt', () => {
    expect(createSkillRuntime(new Map()).resolveSkillInvocation('missing', '', 'user')).toMatchObject({
      name: 'missing', eligible: false, prompt: '', diagnostics: [expect.stringMatching(/not found/i)],
    })
  })

  it('reads the current registry on each invocation', () => {
    const skills = new Map([['current', { name: 'current', description: 'Current', prompt: 'Before' }]])
    const runtime = createSkillRuntime(skills)
    skills.set('current', { name: 'current', description: 'Current', prompt: 'After' })
    expect(runtime.resolveSkillInvocation('current', '', 'user').prompt).toBe('After')
  })
})
