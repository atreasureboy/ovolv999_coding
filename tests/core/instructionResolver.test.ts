import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadOvogoMd } from '../../src/config/ovogomd.js'
import { findMemoryFiles } from '../../src/core/systemPrompt.js'
import {
  resolveInstructions, resolveTargetInstructions, formatInstructionsForPrompt, getInstructionDiagnostics,
  INSTRUCTION_LIMITS,
} from '../../src/core/instructionResolver.js'

let fixture: string
let project: string

function file(relative: string, content: string | Buffer): string {
  const path = join(project, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  return path
}

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'ovogo-path-instructions-'))
  project = join(fixture, 'project')
  mkdirSync(project)
  execFileSync('git', ['init', '--quiet'], { cwd: project })
  vi.stubEnv('HOME', join(fixture, 'home'))
  vi.stubEnv('USERPROFILE', join(fixture, 'home'))
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(fixture, { recursive: true, force: true })
})

describe('shared instruction discovery', () => {
  it('includes compatible CLAUDE instructions before existing native precedence', () => {
    file('CLAUDE.md', 'compatible rule')
    file('OVOGO.md', 'native rule')
    file('AGENTS.md', 'shared rule')
    file('.ovogo/OVOGO.md', 'private rule')
    expect(loadOvogoMd(project).map(entry => entry.content)).toEqual([
      'compatible rule', 'native rule', 'shared rule', 'private rule',
    ])
  })

  it('keeps legacy memory discovery inside the repository root', () => {
    writeFileSync(join(fixture, 'CLAUDE.md'), 'unrelated ancestor')
    file('CLAUDE.md', 'repository rule')
    const cwd = join(project, 'nested')
    mkdirSync(cwd)
    expect(findMemoryFiles(cwd).map(entry => entry.content)).toEqual(['repository rule'])
  })

  it('preserves the legacy parent label for inherited CLAUDE files', () => {
    file('CLAUDE.md', 'repository rule')
    const cwd = join(project, 'nested')
    mkdirSync(cwd)
    expect(findMemoryFiles(cwd)[0].relative).toBe('parent:project/CLAUDE.md')
  })

  it('reports an existing instruction that is not a regular readable file', () => {
    mkdirSync(join(project, 'AGENTS.md'))
    expect(() => loadOvogoMd(project)).toThrow(/instruction.*AGENTS\.md.*regular file/i)
  })

  it('rejects malformed UTF-8 instead of injecting replacement characters', () => {
    file('AGENTS.md', Buffer.from([0xc3, 0x28]))
    expect(() => loadOvogoMd(project)).toThrow(/instruction.*AGENTS\.md.*utf-8/i)
  })
})

describe('path instruction resolver', () => {
  it('loads the root-to-cwd chain and only actual target ancestors', async () => {
    const root = file('AGENTS.md', 'root rule')
    const working = file('work/AGENTS.md', 'working directory rule')
    const target = file('packages/a/AGENTS.md', 'package a rule')
    file('packages/b/AGENTS.md', 'package b rule')
    file('packages/a/nested/AGENTS.md', 'unvisited descendant rule')
    const entries = await resolveInstructions(join(project, 'work'), ['../packages/a/new.ts'])
    expect(entries.map(entry => entry.path)).toEqual([root, working, target])
    expect(entries.map(entry => entry.scope)).toEqual([project, join(project, 'work'), join(project, 'packages/a')])
    expect(entries.every(entry => /^[a-f0-9]{64}$/.test(entry.digest))).toBe(true)
  })

  it('retains both sibling scopes with an explicit conflict diagnostic', async () => {
    file('AGENTS.md', 'root rule')
    const a = file('a/AGENTS.md', 'use tabs')
    const b = file('b/AGENTS.md', 'use spaces')
    const entries = await resolveInstructions(project, ['b/new.ts', 'a/new.ts', 'a/new.ts'])
    expect(entries.map(entry => entry.path)).toEqual([join(project, 'AGENTS.md'), a, b])
    expect(getInstructionDiagnostics(entries)).toEqual([expect.objectContaining({
      code: 'incomparable-scopes', scopes: [join(project, 'a'), join(project, 'b')],
    })])
    const prompt = formatInstructionsForPrompt(entries)
    expect(prompt).toContain('Apply each source only to its stated scope')
    expect(prompt).toContain('incomparable-scopes')
    for (const entry of entries) {
      expect(prompt).toContain(JSON.stringify(entry.path))
      expect(prompt).toContain(JSON.stringify(entry.scope))
      expect(prompt).toContain(entry.digest)
      expect(prompt).toContain(entry.content)
    }
  })

  it('refreshes modified, created and deleted files on every resolution', async () => {
    const path = file('a/AGENTS.md', 'initial rule')
    const initial = await resolveInstructions(project, ['a/new.ts'])
    writeFileSync(path, 'changed rule')
    const changed = await resolveInstructions(project, ['a/new.ts'])
    expect(changed[0].content).toBe('changed rule')
    expect(changed[0].digest).not.toBe(initial[0].digest)
    unlinkSync(path)
    expect(await resolveInstructions(project, ['a/new.ts'])).toEqual([])
    file('a/CLAUDE.md', 'replacement rule')
    expect((await resolveInstructions(project, ['a/new.ts']))[0].content).toBe('replacement rule')
  })

  it('deduplicates directory targets and includes their own instructions', async () => {
    const path = file('a/AGENTS.md', 'directory rule')
    expect((await resolveInstructions(project, ['a', './a', 'a/new.ts'])).map(entry => entry.path)).toEqual([path])
  })

  it('keeps personal instructions first and scoped globally', async () => {
    const home = join(fixture, 'home')
    mkdirSync(join(home, '.ovogo'), { recursive: true })
    const personal = join(home, '.ovogo', 'OVOGO.md')
    writeFileSync(personal, 'personal rule')
    file('AGENTS.md', 'project rule')
    expect((await resolveInstructions(project, [])).map(entry => [entry.path, entry.scope])).toEqual([
      [personal, '*'], [join(project, 'AGENTS.md'), project],
    ])
  })

  it('does not inject the personal source twice when it is also in the cwd chain', async () => {
    const home = join(fixture, 'home')
    mkdirSync(join(home, '.ovogo'), { recursive: true })
    const path = join(home, '.ovogo', 'OVOGO.md')
    writeFileSync(path, 'personal rule')
    expect((await resolveInstructions(home, [])).map(entry => [entry.path, entry.scope])).toEqual([[path, '*']])
  })

  it('applies compatibility precedence separately at every ancestor', async () => {
    for (const name of ['.ovogo/OVOGO.md', 'AGENTS.md', 'OVOGO.md', '.ovolv999/instructions.md', '.ovolv999/CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.md']) file(name, name)
    file('a/CLAUDE.md', 'child rule')
    expect((await resolveInstructions(project, ['a/new.ts'])).map(entry => entry.content)).toEqual([
      'CLAUDE.md', '.claude/CLAUDE.md', '.ovolv999/CLAUDE.md', '.ovolv999/instructions.md',
      'OVOGO.md', 'AGENTS.md', '.ovogo/OVOGO.md', 'child rule',
    ])
  })

  it('rejects targets outside the repository without importing their instructions', async () => {
    writeFileSync(join(fixture, 'AGENTS.md'), 'outside rule')
    await expect(resolveInstructions(project, ['../outside.ts'])).rejects.toMatchObject({ code: 'outside-root' })
  })

  it('uses cwd as the boundary outside a Git repository', async () => {
    const plain = join(fixture, 'plain')
    mkdirSync(plain)
    writeFileSync(join(fixture, 'CLAUDE.md'), 'outside ancestor')
    writeFileSync(join(plain, 'AGENTS.md'), 'local rule')
    expect((await resolveInstructions(plain, ['nested/new.ts'])).map(entry => entry.content)).toEqual(['local rule'])
  })

  it('resolves an internal directory alias using the physical target ancestry', async () => {
    const path = file('actual/AGENTS.md', 'physical rule')
    symlinkSync(join(project, 'actual'), join(project, 'alias'), 'junction')
    expect((await resolveInstructions(project, ['alias/new.ts'])).map(entry => entry.path)).toEqual([path])
  })

  it('rejects directory junctions that escape the repository', async () => {
    const outside = join(fixture, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'AGENTS.md'), 'escaped rule')
    symlinkSync(outside, join(project, 'escape'), 'junction')
    await expect(resolveInstructions(project, ['escape/new.ts'])).rejects.toMatchObject({ code: 'symlink-escape' })
  })

  it('rejects linked instruction directories that escape the repository', async () => {
    const outside = join(fixture, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'OVOGO.md'), 'escaped rule')
    symlinkSync(outside, join(project, '.ovogo'), 'junction')
    await expect(resolveInstructions(project, [])).rejects.toMatchObject({ code: 'symlink-escape' })
  })

  it('rejects invalid binary instruction content with source details', async () => {
    const path = file('AGENTS.md', 'before\0after')
    await expect(resolveInstructions(project, [])).rejects.toMatchObject({ code: 'malformed', path })
  })

  it('refuses oversized files instead of silently dropping part of a rule', async () => {
    const path = file('AGENTS.md', 'x'.repeat(INSTRUCTION_LIMITS.fileBytes + 1))
    await expect(resolveInstructions(project, [])).rejects.toMatchObject({ code: 'capacity', path })
  })

  it('refuses too many lines even when the file fits the byte limit', async () => {
    file('AGENTS.md', 'line\n'.repeat(INSTRUCTION_LIMITS.fileLines + 1))
    await expect(resolveInstructions(project, [])).rejects.toMatchObject({ code: 'capacity' })
  })

  it('refuses oversized aggregate instruction content', async () => {
    const targets: string[] = []
    for (let index = 0; index < 12; index++) {
      file(`p${index}/AGENTS.md`, 'x'.repeat(24_000))
      targets.push(`p${index}/new.ts`)
    }
    await expect(resolveInstructions(project, targets)).rejects.toMatchObject({ code: 'capacity' })
  })

  it('bounds target traversal before reading instruction files', async () => {
    await expect(resolveInstructions(project, Array.from({ length: INSTRUCTION_LIMITS.targetPaths + 1 }, (_, index) => `p${index}/new.ts`))).rejects.toMatchObject({ code: 'capacity' })
  })

  it('bounds deep target ancestry even when its files do not exist yet', async () => {
    const deep = Array.from({ length: INSTRUCTION_LIMITS.directories + 1 }, () => 'a').join('/')
    await expect(resolveInstructions(project, [`${deep}/new.ts`])).rejects.toMatchObject({ code: 'capacity' })
  })

  it('returns immutable snapshots and formats an empty result as empty', async () => {
    file('AGENTS.md', 'original rule')
    const entries = await resolveInstructions(project, [])
    expect(Object.isFrozen(entries)).toBe(true)
    expect(Object.isFrozen(entries[0])).toBe(true)
    expect(formatInstructionsForPrompt([])).toBe('')
  })
})

describe('explicit external target instruction discovery', () => {
  it('keeps external parent rules in a distinct boundary from the startup repository', async () => {
    file('AGENTS.md', 'startup rule')
    const external = join(fixture, 'external.txt')
    writeFileSync(external, 'external content')
    writeFileSync(join(fixture, 'AGENTS.md'), 'external parent rule')
    const snapshot = await resolveTargetInstructions(project, [external], { allowExternalTargets: true })
    expect(snapshot).toMatchObject({
      startupBoundary: project,
      targetBoundaries: [{ path: external, boundary: fixture }],
      instructions: [
        expect.objectContaining({ scope: project, boundary: project, content: 'startup rule' }),
        expect.objectContaining({ scope: fixture, boundary: fixture, content: 'external parent rule' }),
      ],
    })
  })

  it('allows an explicit external target without importing unrelated parent or sibling rules', async () => {
    const startup = file('AGENTS.md', 'startup rule')
    const outside = join(fixture, 'outside')
    mkdirSync(outside)
    const external = join(outside, 'AGENTS.md')
    writeFileSync(external, 'external rule')
    writeFileSync(join(fixture, 'AGENTS.md'), 'unrelated parent rule')
    file('sibling/AGENTS.md', 'unrelated sibling rule')
    expect((await resolveTargetInstructions(project, [join(outside, 'new.ts')], { allowExternalTargets: true })).instructions.map(entry => entry.path)).toEqual([startup, external])
    await expect(resolveTargetInstructions(project, [join(outside, 'new.ts')])).rejects.toMatchObject({ code: 'outside-root' })
  })

  it('uses an external target repository root instead of the startup repository root', async () => {
    const outside = join(fixture, 'outside')
    mkdirSync(join(outside, 'nested'), { recursive: true })
    execFileSync('git', ['init', '--quiet'], { cwd: outside })
    writeFileSync(join(outside, 'AGENTS.md'), 'external root rule')
    writeFileSync(join(outside, 'nested', 'CLAUDE.md'), 'external nested rule')
    writeFileSync(join(fixture, 'CLAUDE.md'), 'unrelated parent rule')
    expect((await resolveTargetInstructions(project, [join(outside, 'nested', 'new.ts')], { allowExternalTargets: true })).instructions.map(entry => entry.content)).toEqual(['external root rule', 'external nested rule'])
  })

  it('uses physical external ancestry through an explicitly allowed directory alias', async () => {
    const outside = join(fixture, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'AGENTS.md'), 'external physical rule')
    symlinkSync(outside, join(project, 'alias'), 'junction')
    expect((await resolveTargetInstructions(project, ['alias/new.ts'], { allowExternalTargets: true })).instructions.map(entry => entry.path)).toEqual([join(outside, 'AGENTS.md')])
    await expect(resolveTargetInstructions(project, ['alias/new.ts'])).rejects.toMatchObject({ code: 'symlink-escape' })
  })

  it('refreshes external sources and reports malformed rules instead of reusing old content', async () => {
    const outside = join(fixture, 'outside')
    mkdirSync(outside)
    const source = join(outside, 'AGENTS.md')
    writeFileSync(source, 'external initial')
    const target = join(outside, 'new.ts')
    expect((await resolveTargetInstructions(project, [target], { allowExternalTargets: true })).instructions[0].content).toBe('external initial')
    writeFileSync(source, Buffer.from([0xc3, 0x28]))
    await expect(resolveTargetInstructions(project, [target], { allowExternalTargets: true })).rejects.toMatchObject({ code: 'malformed', path: source })
    unlinkSync(source)
    expect((await resolveTargetInstructions(project, [target], { allowExternalTargets: true })).instructions).toEqual([])
  })

  it('enforces one combined byte budget across independent external boundaries', async () => {
    const targets: string[] = []
    for (let index = 0; index < 12; index++) {
      const outside = join(fixture, `outside-${index}`)
      mkdirSync(outside)
      writeFileSync(join(outside, 'AGENTS.md'), 'x'.repeat(24_000))
      targets.push(join(outside, 'new.ts'))
    }
    await expect(resolveTargetInstructions(project, targets, { allowExternalTargets: true })).rejects.toMatchObject({ code: 'capacity' })
  })

  it('enforces one combined directory budget across independent external boundaries', async () => {
    const targets: string[] = []
    for (let index = 0; index < 3; index++) {
      const outside = join(fixture, `outside-${index}`)
      mkdirSync(outside)
      targets.push(join(outside, ...Array.from({ length: 90 }, () => 'nested'), 'new.ts'))
    }
    await expect(resolveTargetInstructions(project, targets, { allowExternalTargets: true })).rejects.toMatchObject({ code: 'capacity' })
  })
})
