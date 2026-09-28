import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dispatchSlashCommand } from '../src/commands/index.js'
import type { SlashCommandContext } from '../src/commands/index.js'
import '../src/commands/builtin.js'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'ovogo-esm-commands-'))
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'fixture-project' }))
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('lazy slash-command modules in ESM', () => {
  it.each([
    ['/budget', /budget/i],
    ['/profile list', /profile/i],
    ['/snippet list', /snippet/i],
    ['/knowledge', /knowledge/i],
    ['/metrics file package.json', /package\.json/i],
    ['/keybindings', /shortcut/i],
  ])('loads %s through the registered command entry', async (command, expected) => {
    const result = await dispatchSlashCommand(command, { cwd: directory, history: [] } as unknown as SlashCommandContext)
    expect(result?.type).toBe('text')
    if (result?.type === 'text') expect(result.value).toMatch(expected)
  })
})
