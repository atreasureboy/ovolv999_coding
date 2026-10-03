import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { extractSkill, saveSkill, skillExists } from '../../src/skills/extractor.js'
import { expandSkillPrompt, loadSkills } from '../../src/skills/loader.js'

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
})
