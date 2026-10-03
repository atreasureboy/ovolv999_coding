import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  clearRegistry,
  dispatchSlashCommand,
  getCommand,
  listCommands,
  type SlashCommandContext,
} from '../../src/commands/index.js'
import { registerBuiltinCommands } from '../../src/commands/builtin.js'

describe('built-in command registration', () => {
  it('retains canonical commands across all command domains', () => {
    const canonicalNames = [
      'exit',
      'clear',
      'reset',
      'history',
      'compact',
      'cost',
      'mode',
      'context',
      'model',
      'permissions',
      'poor',
      'rewind',
      'undo',
      'tasks',
      'workers',
      'doctor',
      'diff',
      'commit',
      'git',
      'init',
      'skills',
      'help',
      'export',
      'review',
      'security-review',
      'branch',
      'resume',
      'sessions',
      'status',
      'files',
      'config',
      'cwd',
      'search',
      'version',
      'copy',
      'retry',
      'keybindings',
      'workflow',
      'vim',
      'models',
      'skill-save',
      'style',
      'audit',
      'plugins',
      'suggest',
      'scan',
      'share',
      'notify',
      'debug-tool-call',
      'schedule',
      'stats',
      'diff-browser',
      'knowledge',
      'onboard',
      'cmd-history',
      'bookmark',
      'budget',
      'timer',
      'snapshot',
      'snippet',
      'profile',
      'metrics',
      'hooks',
      'diagnostics',
      'goal',
      'transcript',
      'effort',
      'team-memory',
      'vault',
      'daemon',
      'dream',
      'messages',
      'sandbox',
      'sync',
      'telemetry',
      'magic-docs',
      'ssh',
      'lsp',
      'update',
      'cache',
      'health',
      'ide',
    ]
    for (const name of canonicalNames) expect(getCommand(name)).toBeDefined()
    expect(listCommands()).toHaveLength(136)
  })

  it.each([
    ['kb', 'knowledge'],
    ['snip', 'snippet'],
    ['health', 'health'],
    ['plugin', 'plugins'],
    ['keys', 'keybindings'],
    ['m', 'model'],
  ])('keeps the final /%s handler associated with /%s', (alias, command) => {
    expect(getCommand(alias)?.handler).toBe(getCommand(command)?.handler)
  })

  it('exports JSON to the requested filename through the effective export handler', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ovogo-command-export-'))
    try {
      const context = {
        cwd: directory,
        history: [{ role: 'user', content: 'Exported question' }],
      } as SlashCommandContext
      const result = await dispatchSlashCommand('/export json requested.json', context)
      expect(result?.type).toBe('text')
      expect(JSON.parse(readFileSync(join(directory, 'requested.json'), 'utf8'))).toEqual([
        { role: 'user', content: 'Exported question' },
      ])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('supports the effective plugin handler info action through its alias', async () => {
    const result = await dispatchSlashCommand(
      '/plugin info missing-registration-fixture',
      {} as SlashCommandContext,
    )
    expect(result).toEqual({ type: 'text', value: 'Not found: missing-registration-fixture' })
  })

  it('restores built-ins after a registry clear without re-importing modules', () => {
    clearRegistry()
    registerBuiltinCommands()
    expect(listCommands()).toHaveLength(136)
    expect(getCommand('kb')?.handler).toBe(getCommand('knowledge')?.handler)
    expect(getCommand('snip')?.handler).toBe(getCommand('snippet')?.handler)
  })

  it('loads command groups without changing the shared registry', async () => {
    vi.resetModules()
    const registry = await import('../../src/commands/index.js')
    await import('../../src/commands/automationCommands.js')
    await import('../../src/commands/knowledgeCommands.js')
    await import('../../src/commands/configurationCommands.js')
    expect(registry.listCommands()).toEqual([])
    await import('../../src/commands/builtin.js')
    expect(registry.listCommands()).toHaveLength(136)
    expect(registry.getCommand('kb')?.handler).toBe(registry.getCommand('knowledge')?.handler)
  })
})
