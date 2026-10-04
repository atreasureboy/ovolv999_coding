import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'fs'
import { randomBytes } from 'crypto'
import { resolve, join, dirname } from 'path'
import { homedir } from 'os'
import { normalizeSettings } from './settings/normalization.js'
import { applySettingsPatch, mergeSettingsLayers } from './settings/merge.js'
import type { OvogoSettings } from './settings/types.js'
import { ExecutionPolicyError } from '../core/executionPolicy.js'

export type { HookEntry, HooksConfig, PermissionsConfig, TaskContext, OvogoSettings } from './settings/types.js'

function tryParse(path: string): OvogoSettings | undefined {
  let content: string
  try { content = readFileSync(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new ExecutionPolicyError(`Invalid settings at ${path}: configuration could not be read`)
  }
  try {
    const parsed: unknown = JSON.parse(content)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ExecutionPolicyError('Settings must be a JSON object')
    return normalizeSettings(parsed)
  } catch (error) {
    throw new ExecutionPolicyError(`Invalid settings at ${path}: ${error instanceof ExecutionPolicyError ? error.message : 'configuration could not be read or parsed as JSON'}`)
  }
}

export function getProjectSettingsPath(cwd: string): string {
  return resolve(cwd, '.ovogo', 'settings.json')
}

export function loadProjectSettings(cwd: string): OvogoSettings {
  const projectPath = getProjectSettingsPath(cwd)
  return tryParse(projectPath) ?? {}
}

export function saveProjectSettings(cwd: string, patch: OvogoSettings): OvogoSettings {
  const projectPath = getProjectSettingsPath(cwd)
  const current = loadProjectSettings(cwd)
  const next = normalizeSettings(applySettingsPatch(current, patch))

  mkdirSync(dirname(projectPath), { recursive: true })
  const tmpPath = `${projectPath}.tmp.${process.pid}.${Date.now()}.${randomBytes(8).toString('hex')}`
  try {
    writeFileSync(tmpPath, JSON.stringify(next, null, 2) + '\n', 'utf8')
    renameSync(tmpPath, projectPath)
  } catch (err) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath)
    } catch {
      throw err
    }
    throw err
  }
  return next
}

export function loadSettings(cwd: string): OvogoSettings {
  const globalPath = join(homedir(), '.ovogo', 'settings.json')
  const projectPath = getProjectSettingsPath(cwd)

  let settings: OvogoSettings = {}
  const global = tryParse(globalPath)
  const project = tryParse(projectPath)
  if (global !== undefined) settings = mergeSettingsLayers(settings, global)
  if (project !== undefined) settings = mergeSettingsLayers(settings, project)
  return settings
}
