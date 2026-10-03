import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'fs'
import { randomBytes } from 'crypto'
import { resolve, join, dirname } from 'path'
import { homedir } from 'os'
import { normalizeSettings } from './settings/normalization.js'
import { applySettingsPatch, mergeSettingsLayers } from './settings/merge.js'
import type { OvogoSettings } from './settings/types.js'

export type { HookEntry, HooksConfig, PermissionsConfig, TaskContext, OvogoSettings } from './settings/types.js'

function tryParse(path: string): OvogoSettings {
  try {
    return normalizeSettings(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return {}
  }
}

export function getProjectSettingsPath(cwd: string): string {
  return resolve(cwd, '.ovogo', 'settings.json')
}

export function loadProjectSettings(cwd: string): OvogoSettings {
  const projectPath = getProjectSettingsPath(cwd)
  return existsSync(projectPath) ? tryParse(projectPath) : {}
}

export function saveProjectSettings(cwd: string, patch: OvogoSettings): OvogoSettings {
  const projectPath = getProjectSettingsPath(cwd)
  const current = loadProjectSettings(cwd)
  const next = applySettingsPatch(current, patch)

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
  if (existsSync(globalPath)) settings = mergeSettingsLayers(settings, tryParse(globalPath))
  if (existsSync(projectPath)) settings = mergeSettingsLayers(settings, tryParse(projectPath))
  return settings
}
