import { expandSkillPrompt, type Skill } from './loader.js'

export type SkillRegistryEntry = Pick<Skill, 'name' | 'description' | 'prompt'> & Partial<Omit<Skill, 'name' | 'description' | 'prompt'>>

export interface SkillInvocation {
  name: string
  args: string
  prompt: string
  sourcePath: string
  eligible: boolean
  requiredTools: readonly string[]
  restrictedTools?: readonly string[]
  permissionGrants?: readonly string[]
  diagnostics: readonly string[]
}

export type SkillInvocationResolver = (name: string, args: string, origin: 'user' | 'model') => SkillInvocation

export interface SkillRuntime {
  resolveSkillInvocation: SkillInvocationResolver
}

export function createSkillRuntime(skills: ReadonlyMap<string, SkillRegistryEntry>): SkillRuntime {
  return {
    resolveSkillInvocation(name, args, origin) {
      const normalizedArgs = args.trim()
      const skill = skills.get(name)
      if (!skill) {
        return { name, args: normalizedArgs, prompt: '', sourcePath: '', eligible: false, requiredTools: [], diagnostics: [`Skill "${name}" not found`] }
      }
      const sourcePath = skill.sourcePath ?? `${skill.source ?? 'registry'}:skill/${skill.name}`
      const requiredTools = [...new Set([...(skill.requiredTools ?? []), ...(skill.tools ?? [])])]
      const diagnostics = [...(skill.diagnostics ?? [])]
      let eligible = true
      if (origin === 'model' && skill.disableModelInvocation) {
        eligible = false
        diagnostics.push(`Skill "${name}" is user-only: model invocation is disabled`)
      }
      if (origin === 'user' && skill.userInvocable === false) {
        eligible = false
        diagnostics.push(`Skill "${name}" does not allow user invocation`)
      }
      for (const key of skill.unsupportedMetadata ?? []) {
        eligible = false
        if (!diagnostics.some((diagnostic) => diagnostic.includes(key))) diagnostics.push(`Unsupported skill metadata: ${key}`)
      }
      if (skill.restrictedTools?.length) {
        eligible = false
        if (!diagnostics.some((diagnostic) => diagnostic.includes('tool restrictions'))) diagnostics.push('Unsupported skill tool restrictions: enforcement is unavailable')
      }
      if (skill.permissionGrants?.length) {
        eligible = false
        if (!diagnostics.some((diagnostic) => diagnostic.includes('permission grants'))) diagnostics.push('Unsupported skill permission grants: grants are unavailable')
      }
      return {
        name: skill.name, args: normalizedArgs, prompt: eligible ? expandSkillPrompt({ ...skill, source: skill.source ?? 'project' }, normalizedArgs) : '',
        sourcePath, eligible, requiredTools,
        ...(skill.restrictedTools?.length ? { restrictedTools: [...skill.restrictedTools] } : {}),
        ...(skill.permissionGrants?.length ? { permissionGrants: [...skill.permissionGrants] } : {}),
        diagnostics,
      }
    },
  }
}

export function formatSkillInvocation(invocation: SkillInvocation): string {
  return [`Skill /${invocation.name} · ${invocation.sourcePath}`, ...invocation.diagnostics].join('\n')
}
