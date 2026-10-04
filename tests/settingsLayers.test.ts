import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getProjectSettingsPath, loadProjectSettings, loadSettings, saveProjectSettings, type HooksConfig, type OvogoSettings } from '../src/config/settings.js'

let root: string
let cwd: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ovogo-settings-layers-'))
  cwd = join(root, 'project')
  mkdirSync(cwd)
  vi.stubEnv('HOME', root)
  vi.stubEnv('USERPROFILE', root)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

function writeSettings(path: string, settings: unknown): void {
  mkdirSync(join(path, '.ovogo'), { recursive: true })
  writeFileSync(join(path, '.ovogo', 'settings.json'), JSON.stringify(settings))
}

describe('settings layers', () => {
  it('appends every project hook after its global hooks', () => {
    const globalHooks: HooksConfig = {
      PreToolCall: [{ command: 'pre-global' }],
      PostToolCall: [{ command: 'post-global' }],
      UserPromptSubmit: [{ command: 'prompt-global' }],
      OnError: [{ command: 'error-global' }],
      OnComplete: [{ command: 'complete-global' }],
      OnContextOverflow: [{ command: 'overflow-global' }],
    }
    const projectHooks: HooksConfig = {
      PreToolCall: [{ command: 'pre-project' }],
      PostToolCall: [{ command: 'post-project' }],
      UserPromptSubmit: [{ command: 'prompt-project' }],
      OnError: [{ command: 'error-project' }],
      OnComplete: [{ command: 'complete-project' }],
      OnContextOverflow: [{ command: 'overflow-project' }],
    }
    writeSettings(root, { hooks: globalHooks })
    writeSettings(cwd, { hooks: projectHooks })
    expect(loadSettings(cwd).hooks).toEqual({
      PreToolCall: [{ command: 'pre-global' }, { command: 'pre-project' }],
      PostToolCall: [{ command: 'post-global' }, { command: 'post-project' }],
      UserPromptSubmit: [{ command: 'prompt-global' }, { command: 'prompt-project' }],
      OnError: [{ command: 'error-global' }, { command: 'error-project' }],
      OnComplete: [{ command: 'complete-global' }, { command: 'complete-project' }],
      OnContextOverflow: [{ command: 'overflow-global' }, { command: 'overflow-project' }],
    })
  })

  it('inherits omitted fields while project permissions append and MCP replaces', () => {
    writeSettings(root, {
      taskContext: { name: 'global', phase: 'design', scope: ['src'], notes: 'keep' },
      permissions: { mode: 'auto', rules: [{ toolName: 'Read', ruleContent: '**', behavior: 'allow', source: 'user' }] },
      mcp: { servers: [{ name: 'global', command: ['global-command'] }] },
      poor: { enabled: true },
    })
    writeSettings(cwd, {
      taskContext: { name: 'project' },
      permissions: { mode: 'plan', rules: [{ toolName: 'Write', ruleContent: '**', behavior: 'ask', source: 'project' }] },
      mcp: { servers: [{ name: 'project', command: ['project-command'], env: { KEEP: 'value', DROP: 123 } }] },
      poor: { enabled: false },
    })
    const settings = loadSettings(cwd)
    expect(settings.taskContext).toEqual({ name: 'project', phase: 'design', scope: ['src'], notes: 'keep' })
    expect(settings.permissions).toEqual({ mode: 'plan', rules: [
      { toolName: 'Read', ruleContent: '**', behavior: 'allow', source: 'user' },
      { toolName: 'Write', ruleContent: '**', behavior: 'ask', source: 'project' },
    ] })
    expect(settings.mcp?.servers).toEqual([{ name: 'project', type: 'stdio', command: ['project-command'], env: { KEEP: 'value' }, cwd: undefined }])
    expect(settings.poor).toEqual({ enabled: false })
  })

  it('replaces explicit patch hook arrays without importing global settings', () => {
    writeSettings(root, { taskContext: { name: 'global' }, hooks: { OnError: [{ command: 'global' }] } })
    writeSettings(cwd, {
      taskContext: { name: 'project' },
      hooks: { PreToolCall: [{ command: 'original' }], OnError: [{ command: 'old-error' }] },
      permissions: { mode: 'auto', rules: [{ toolName: 'Read', ruleContent: '**', behavior: 'allow', source: 'project' }] },
    })
    const patch: OvogoSettings = { hooks: { PreToolCall: [] }, permissions: { mode: 'plan' } }
    saveProjectSettings(cwd, patch)
    const saved = JSON.parse(readFileSync(getProjectSettingsPath(cwd), 'utf8'))
    expect(saved.hooks).toEqual({ PreToolCall: [] })
    expect(saved.taskContext).toEqual({ name: 'project' })
    expect(saved.permissions).toEqual({ mode: 'plan', rules: [{ toolName: 'Read', ruleContent: '**', behavior: 'allow', source: 'project' }] })
  })

  it('filters invalid MCP entries and refuses malformed saved JSON', () => {
    writeSettings(cwd, { mcp: { servers: [null, { name: '', command: ['x'] }, { name: 'broken', command: [1] }, { name: 'ok', command: ['run'], type: 'http' }] } })
    expect(loadProjectSettings(cwd).mcp?.servers).toEqual([{ name: 'ok', type: 'stdio', command: ['run'], env: undefined, cwd: undefined }])
    writeFileSync(getProjectSettingsPath(cwd), '{broken')
    expect(() => loadProjectSettings(cwd)).toThrow(getProjectSettingsPath(cwd))
  })
})
