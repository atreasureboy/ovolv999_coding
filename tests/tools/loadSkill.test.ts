import { describe, expect, it } from 'vitest'
import type { ToolContext } from '../../src/core/types.js'
import { createLoadSkillTool } from '../../src/tools/loadSkill.js'

const context: ToolContext = { cwd: process.cwd(), permissionMode: 'auto', availableToolNames: ['Read'] }

describe('load_skill invocation policy', () => {
  it('refuses model-triggered loading of a user-only skill', async () => {
    const skills = new Map([['manual', { name: 'manual', description: 'Manual', prompt: 'Private user task', disableModelInvocation: true }]])
    const result = await createLoadSkillTool(skills).execute({ skill_name: 'manual' }, context)
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/user.only|model invocation.*disabled/i)
    expect(result.content).not.toContain('Private user task')
  })

  it('checks named required tools without granting permissions', async () => {
    const skills = new Map([['needs-write', { name: 'needs-write', description: 'Needs Write', prompt: 'Task', requiredTools: ['Write'] }]])
    const result = await createLoadSkillTool(skills).execute({ skill_name: 'needs-write' }, context)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('requires tools not available: Write')
    expect(context.availableToolNames).toEqual(['Read'])
  })

  it.each([
    { restrictedTools: ['Write'] },
    { permissionGrants: ['Bash'] },
  ])('blocks unsupported enforcement rather than loading the prompt: %j', async (metadata) => {
    const skills = new Map([['policy', { name: 'policy', description: 'Policy', prompt: 'Policy task', ...metadata }]])
    const result = await createLoadSkillTool(skills).execute({ skill_name: 'policy' }, context)
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/unsupported/i)
    expect(result.content).not.toContain('Policy task')
  })

  it('loads on demand with literal arguments, provenance, and diagnostic warnings', async () => {
    const skills = new Map([['inspect', {
      name: 'inspect', description: 'Inspect', prompt: 'Inspect $ARGS', sourcePath: '/project/skills/inspect.md',
      tools: ['Read'], diagnostics: ['Unknown skill metadata: future-option'],
    }]])
    const result = await createLoadSkillTool(skills).execute({ skill_name: 'inspect', args: '$& src' }, context)
    expect(result.isError).toBe(false)
    expect(result.content).toContain('Inspect $& src')
    expect(result.content).toContain('/project/skills/inspect.md')
    expect(result.content).toContain('Required tools**: Read')
    expect(result.content).toContain('Unknown skill metadata: future-option')
  })

  it('keeps legacy required tools and missing-skill behavior compatible', async () => {
    const skills = new Map([['legacy', { name: 'legacy', description: 'Legacy', prompt: 'Legacy prompt', tools: ['Write'] }]])
    expect((await createLoadSkillTool(skills).execute({ skill_name: 'legacy' }, context)).content).toContain('requires tools not available: Write')
    expect((await createLoadSkillTool(skills).execute({ skill_name: 'missing' }, context)).isError).toBe(true)
  })
})
