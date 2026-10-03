import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type * as ChildProcessApi from 'child_process'
import { loadProjectConfig } from '../src/config/projectConfig.js'
import { loadOvogoMd } from '../src/config/ovogomd.js'
import { runDiagnostics, formatDiagnosticsResult, clearCache } from '../src/core/diagnostics.js'

const execution = vi.hoisted(() => ({ gitRoot: '', error: false }))
vi.mock('child_process', async importOriginal => {
  const original = await importOriginal<typeof ChildProcessApi>()
  return { ...original, execSync: (command: string, options: unknown) => {
    if (command === 'git rev-parse --show-toplevel') return execution.gitRoot
    if (command.startsWith('npx tsc') && execution.error) throw Object.assign(new Error('compiler unavailable'), { status: 127, stderr: 'TypeScript compiler could not start', stdout: '' })
    return original.execSync(command, options as never)
  } }
})

const directories: string[] = []
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'runtime-config-audit-'))
  directories.push(path)
  return path
}
afterEach(() => {
  execution.gitRoot = ''
  execution.error = false
  clearCache()
  vi.unstubAllEnvs()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

it('does not inherit project configuration above a repository boundary', () => {
  const root = directory()
  const project = join(root, 'project')
  mkdirSync(join(project, '.git'), { recursive: true })
  writeFileSync(join(root, '.ovolv999.json'), '{"permissionMode":"auto"}')
  expect(loadProjectConfig(project)).toBeNull()
})

it('rejects primitive configuration roots and filters invalid startup values', () => {
  const root = directory()
  const path = join(root, '.ovolv999.json')
  writeFileSync(path, '"invalid"')
  expect(loadProjectConfig(root)).toBeNull()
  writeFileSync(path, JSON.stringify({ model: 42, permissionMode: 'fictional', maxIterations: -1, maxContextTokens: '2000', enabledModules: [1, 'memory'], poor: true, temperature: 1, systemPrompt: 'retain' }))
  expect(loadProjectConfig(root)).toEqual({ enabledModules: ['memory'], temperature: 1, systemPrompt: 'retain' })
})

it('resolves relative configuration lookup paths before walking parents', () => {
  const root = directory()
  const child = join(root, 'nested')
  mkdirSync(child)
  writeFileSync(join(root, '.ovolv999.json'), '{"model":"inherited"}')
  expect(loadProjectConfig(resolve(child))).toEqual({ model: 'inherited' })
})

it('canonicalizes the Git root before walking instruction parents on Windows', () => {
  const root = directory()
  vi.stubEnv('HOME', root)
  vi.stubEnv('USERPROFILE', root)
  const project = join(root, 'project')
  const child = join(project, 'nested')
  mkdirSync(child, { recursive: true })
  writeFileSync(join(root, 'AGENTS.md'), 'outside repository')
  writeFileSync(join(project, 'AGENTS.md'), 'inside repository')
  execution.gitRoot = project.replaceAll('\\', '/')
  const files = loadOvogoMd(child)
  expect(files.map(file => file.content)).toEqual(['inside repository'])
})

it('reports checker startup failure instead of a clean diagnostic result', () => {
  const root = directory()
  execution.error = true
  const result = runDiagnostics(root, 'tsc', false)
  expect(result.totalErrors).toBe(1)
  expect(formatDiagnosticsResult(result)).not.toContain('No diagnostics')
  expect(result.files[0].diagnostics[0].message).toContain('TypeScript compiler could not start')
})
