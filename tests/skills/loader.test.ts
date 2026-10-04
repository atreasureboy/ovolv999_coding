import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { extractSkill, saveSkill, skillExists } from '../../src/skills/extractor.js'
import { expandSkillPrompt, formatSkillIndex, loadSkills } from '../../src/skills/loader.js'
import { createLoadSkillTool } from '../../src/tools/loadSkill.js'

let cwd: string

beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'skill-roundtrip-')) })
afterEach(() => rmSync(cwd, { recursive: true, force: true }))

describe('skill persistence and expansion', () => {
  it('loads a saved skill through the public skill registry', () => {
    const extraction = extractSkill([{ role: 'user', content: 'Fix the parser' }], { name: 'parser-fix' })
    saveSkill(cwd, extraction)
    expect(loadSkills(cwd).get(extraction.name)).toMatchObject({ prompt: extraction.prompt.trim(), source: 'project' })
  })

  it('round trips descriptions containing newlines and frontmatter syntax', () => {
    const description = 'Fix this\nname: hijacked\n"quoted"'
    saveSkill(cwd, extractSkill([], { name: 'safe', description }))
    expect(loadSkills(cwd).get('safe')?.description).toBe(description)
    expect(loadSkills(cwd).has('hijacked')).toBe(false)
  })

  it('rejects names that escape the skill directory before creating files', () => {
    expect(() => saveSkill(cwd, extractSkill([], { name: '../../escaped' }))).toThrow(/skill name/i)
    expect(existsSync(join(cwd, 'escaped.md'))).toBe(false)
    expect(skillExists(cwd, '../../escaped')).toBe(false)
  })

  it('keeps the established project directory higher priority than saved legacy skills', () => {
    saveSkill(cwd, extractSkill([], { name: 'same' }))
    mkdirSync(join(cwd, '.ovogo/skills'), { recursive: true })
    writeFileSync(join(cwd, '.ovogo/skills/same.md'), '# Override\nProject prompt')
    expect(loadSkills(cwd).get('same')?.prompt).toBe('# Override\nProject prompt')
  })

  it('substitutes arguments literally even when they contain replacement tokens', () => {
    const skill = loadSkills(cwd).get('review')!
    expect(expandSkillPrompt({ ...skill, prompt: 'Task: $ARGS' }, '$& $` $\' $$')).toBe('Task: $& $` $\' $$')
  })

  it('retains source and separates requirements, restrictions, and permission grants', () => {
    const path = join(cwd, '.ovogo/skills/policy.md')
    mkdirSync(join(cwd, '.ovogo/skills'), { recursive: true })
    writeFileSync(path, '---\nrequired-tools: [Read, Grep]\ntools: Bash\nrestricted-tools: Write, Edit\nallowed-tools: Bash(git status)\n---\nTask: $ARGS')
    expect(loadSkills(cwd).get('policy')).toMatchObject({
      sourcePath: path,
      requiredTools: ['Read', 'Grep', 'Bash'],
      tools: ['Read', 'Grep', 'Bash'],
      restrictedTools: ['Write', 'Edit'],
      permissionGrants: ['Bash(git status)'],
    })
  })

  it('diagnoses unknown metadata without treating nested fields as top-level names', () => {
    mkdirSync(join(cwd, '.ovogo/skills'), { recursive: true })
    writeFileSync(join(cwd, '.ovogo/skills/original.md'), '---\nfuture-option:\n  name: hijacked\n---\nTask')
    const skill = loadSkills(cwd).get('original')
    expect(skill).toBeDefined()
    expect(loadSkills(cwd).has('hijacked')).toBe(false)
    expect(skill?.diagnostics).toEqual(expect.arrayContaining([expect.stringMatching(/unknown.*future-option/i)]))
  })

  it('retains diagnostics for unsupported fork, model, and nested hooks metadata', () => {
    mkdirSync(join(cwd, '.ovogo/skills'), { recursive: true })
    writeFileSync(join(cwd, '.ovogo/skills/complex.md'), '---\ncontext: fork\nmodel: experimental\nhooks:\n  PreToolUse:\n    command: echo hello\n---\nTask')
    const skill = loadSkills(cwd).get('complex')!
    expect(skill.unsupportedMetadata).toEqual(expect.arrayContaining(['context', 'model', 'hooks']))
    expect(skill.diagnostics?.join('\n')).toMatch(/unsupported.*context/i)
    expect(skill.diagnostics?.join('\n')).toMatch(/unsupported.*model/i)
    expect(skill.diagnostics?.join('\n')).toMatch(/unsupported.*hooks/i)
  })

  it('omits user-only skills from the model skill index while retaining user discovery', () => {
    mkdirSync(join(cwd, '.ovogo/skills'), { recursive: true })
    writeFileSync(join(cwd, '.ovogo/skills/manual.md'), '---\ndisable-model-invocation: true\n---\nManual task')
    const skills = loadSkills(cwd)
    expect(skills.get('manual')).toMatchObject({ disableModelInvocation: true })
    expect(formatSkillIndex(skills)).not.toContain('**manual**')
    expect(formatSkillIndex(skills)).toContain('**review**')
  })

  it('ignores frontmatter comments without blocking otherwise supported metadata', () => {
    mkdirSync(join(cwd, '.ovogo/skills'), { recursive: true })
    writeFileSync(join(cwd, '.ovogo/skills/commented.md'), '---\ndescription: Inspect\n  # note: this is a comment\nrequired-tools: Read\n# another: comment\n---\nTask')
    expect(loadSkills(cwd).get('commented')).toMatchObject({ description: 'Inspect', requiredTools: ['Read'], unsupportedMetadata: [], diagnostics: [] })
  })

  it.each([
    '  disable-model-invocation: true\n  restricted-tools: Write',
    '"disable-model-invocation": true\n"restricted-tools": Write',
    "'disable-model-invocation': true\n'restricted-tools': Write",
  ])('does not bypass model eligibility with YAML root indentation or quoted policy keys: %s', async (metadata) => {
    mkdirSync(join(cwd, '.ovogo/skills'), { recursive: true })
    writeFileSync(join(cwd, '.ovogo/skills/protected.md'), `---\n${metadata}\n---\nProtected task`)
    const skills = loadSkills(cwd)
    const loaded = await createLoadSkillTool(skills).execute({ skill_name: 'protected' }, { cwd, permissionMode: 'auto', availableToolNames: ['Write'] })
    expect(loaded.isError).toBe(true)
    expect(loaded.content).not.toContain('Protected task')
    expect(formatSkillIndex(skills)).not.toContain('**protected**')
  })

  it('keeps deeper structured metadata blocked after normalizing root indentation', async () => {
    mkdirSync(join(cwd, '.ovogo/skills'), { recursive: true })
    writeFileSync(join(cwd, '.ovogo/skills/structured.md'), '---\n  description: Structured\n  restricted-tools:\n    - Write\n  hooks:\n    PreToolUse:\n      command: ignored\n---\nStructured task')
    const skills = loadSkills(cwd)
    expect(skills.get('structured')?.unsupportedMetadata).toEqual(expect.arrayContaining(['restricted-tools', 'hooks']))
    expect((await createLoadSkillTool(skills).execute({ skill_name: 'structured' }, { cwd, permissionMode: 'auto' })).isError).toBe(true)
  })
})
