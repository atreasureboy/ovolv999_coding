import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveAgentConfig, validateAgentConfig } from '../../src/core/agentPresets.js'
import { classifyBashCommand, classifyFileWrite } from '../../src/core/autoClassifier.js'
import { classifyCommandRisk } from '../../src/core/riskClassifier.js'
import { MessageBus } from '../../src/core/messageBus.js'
import { installPlugin, getPluginDir, resetRegistry, loadPlugins } from '../../src/core/pluginManager.js'
import { createPluginScaffold } from '../../src/core/plugins.js'
import { setActiveStyle } from '../../src/core/outputStyles.js'
import { EpisodicMemory, isValidEpisode } from '../../src/core/episodicMemory.js'

let cwd: string
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'ovogo-contract-audit-'))
  vi.stubEnv('HOME', cwd)
  vi.stubEnv('USERPROFILE', cwd)
  resetRegistry()
})
afterEach(() => {
  resetRegistry()
  vi.unstubAllEnvs()
  rmSync(cwd, { recursive: true, force: true })
})

describe('core contract audit', () => {
  it.each(['constructor', 'toString', '__proto__'])('rejects non-preset prototype key %s', preset => {
    expect(() => resolveAgentConfig({ preset })).toThrow(/Unknown agent preset/)
  })

  it('isolates all mutable preset collections between resolved agents', () => {
    const first = resolveAgentConfig({ preset: 'general-purpose' })
    first.tools?.push('forbidden-test-tool')
    if (first.modules?.memory) first.modules.memory.contextBudgetRatio = 0.9
    const second = resolveAgentConfig({ preset: 'general-purpose' })
    expect(second.tools).not.toContain('forbidden-test-tool')
    expect(second.modules?.memory?.contextBudgetRatio).toBeUndefined()
  })

  it.each([{ maxIterations: -1 }, { maxIterations: NaN }, { maxIterations: 1.5 },
    { maxOutputTokens: Infinity }, { temperature: NaN }])('rejects invalid agent limits %j', limits => {
    expect(validateAgentConfig({ identity: { systemPrompt: 'test' }, ...limits })).toBeNull()
  })

  it.each(['echo hello > file', 'ls && unknown-command', 'git branch new', 'git remote add x y', 'find . -delete', 'env node script.js', 'env bash -c x'])(
    'does not automatically approve side-effecting command %s', command => {
      expect(classifyBashCommand(command).autoApprove).toBe(false)
      expect(classifyCommandRisk(command)).not.toBe('safe')
    })

  it('recognizes sensitive Windows file paths', () => {
    expect(classifyFileWrite('C:\\project\\.git\\config').autoApprove).toBe(false)
    expect(classifyFileWrite('C:\\project\\.ssh\\config').autoApprove).toBe(false)
  })

  it('delivers a message to only one concurrent receiver', async () => {
    const bus = new MessageBus()
    bus.registerAgent('a', 'A'); bus.registerAgent('b', 'B')
    const first = bus.receive('b', 20)
    const second = bus.receive('b', 20)
    const message = bus.send('a', 'b', 'single')
    expect(await first).toEqual(message)
    expect(await second).toBeNull()
  })

  it('publishes reply association before message listeners run', () => {
    const bus = new MessageBus()
    bus.registerAgent('a', 'A'); bus.registerAgent('b', 'B')
    const original = bus.send('a', 'b', 'question')!
    let observed: string | undefined
    bus.on('message:a', message => { observed = message.replyTo })
    bus.reply(original.id, 'b', 'answer')
    expect(observed).toBe(original.id)
  })

  it('installs actual local plugin files and makes them discoverable', () => {
    const source = join(cwd, 'source')
    mkdirSync(source)
    writeFileSync(join(source, 'plugin.json'), JSON.stringify({ name: 'audit-plugin', version: '1.0.0', main: 'entry.js' }))
    writeFileSync(join(source, 'entry.js'), 'export const tool = "installed"')
    expect(installPlugin({ from: 'local', source }).success).toBe(true)
    expect(readFileSync(join(getPluginDir(), 'audit-plugin', 'entry.js'), 'utf8')).toContain('installed')
    expect(loadPlugins().some(plugin => plugin.manifest.name === 'audit-plugin')).toBe(true)
  })

  it('discovers installed scoped plugins', () => {
    const source = join(cwd, 'source')
    mkdirSync(source)
    writeFileSync(join(source, 'plugin.json'), JSON.stringify({ name: '@scope/audit-plugin', version: '1' }))
    expect(installPlugin({ from: 'local', source }).success).toBe(true)
    expect(loadPlugins().map(plugin => plugin.manifest.name)).toContain('@scope/audit-plugin')
  })

  it('rejects a scaffold name that escapes the plugin directory', () => {
    expect(() => createPluginScaffold(cwd, '../../outside')).toThrow()
  })

  it.each(['broken json', 'null'])('allows choosing a style after damaged configuration %s', raw => {
    mkdirSync(join(cwd, '.ovolv999'))
    writeFileSync(join(cwd, '.ovolv999', 'output-style.json'), raw)
    expect(setActiveStyle(cwd, 'concise')).toEqual({ success: true })
    expect(JSON.parse(readFileSync(join(cwd, '.ovolv999', 'output-style.json'), 'utf8')).active).toBe('concise')
  })

  it('uses empty results for zero episode limits and rejects fractional turns', () => {
    const memory = new EpisodicMemory(cwd)
    const row = memory.write({ turn: 1, toolName: 'Read', inputSummary: 'a', resultSummary: 'ok', outcome: 'success', timestamp: new Date().toISOString() })
    expect(memory.recent(0)).toEqual([])
    expect(memory.findByTool('Read', 0)).toEqual([])
    expect(isValidEpisode({ ...row, turn: 1.5 })).toBe(false)
  })
})
