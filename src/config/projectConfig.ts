/**
 * Project config — loads .ovolv999.json for project-specific settings.
 *
 * Supports:
 *   {
 *     "model": "glm-4.6",
 *     "permissionMode": "default",
 *     "maxIterations": 50,
 *     "maxContextTokens": 200000,
 *     "systemPrompt": "You are a coding assistant.",
 *     "enabledModules": ["memory", "critic"],
 *     "poor": { "enabled": false },
 *     "temperature": 0
 *   }
 *
 * Looked up from cwd up to git root (first one wins).
 */

import { readFileSync, existsSync } from 'fs'
import { join, dirname, resolve } from 'path'

export interface ProjectConfig {
  model?: string
  permissionMode?: 'auto' | 'ask' | 'deny'
  maxIterations?: number
  maxContextTokens?: number
  systemPrompt?: string
  enabledModules?: string[]
  poor?: { enabled: boolean }
  temperature?: number
}

const CONFIG_FILES = ['.ovolv999.json', '.ovolv999.jsonc']

function normalizeProjectConfig(value: unknown): ProjectConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const config: ProjectConfig = {}
  for (const name of ['model', 'systemPrompt'] as const) if (typeof raw[name] === 'string') config[name] = raw[name]
  if (raw.permissionMode === 'auto' || raw.permissionMode === 'ask' || raw.permissionMode === 'deny') config.permissionMode = raw.permissionMode
  for (const name of ['maxIterations', 'maxContextTokens'] as const) if (Number.isSafeInteger(raw[name]) && Number(raw[name]) > 0) config[name] = Number(raw[name])
  if (Array.isArray(raw.enabledModules)) config.enabledModules = raw.enabledModules.filter((name): name is string => typeof name === 'string' && name.length > 0)
  if (raw.poor && typeof raw.poor === 'object' && !Array.isArray(raw.poor) && typeof (raw.poor as Record<string, unknown>).enabled === 'boolean') config.poor = { enabled: (raw.poor as { enabled: boolean }).enabled }
  if (typeof raw.temperature === 'number' && Number.isFinite(raw.temperature) && raw.temperature >= 0 && raw.temperature <= 2) config.temperature = raw.temperature
  return config
}

export function loadProjectConfig(cwd: string): ProjectConfig | null {
  let dir = resolve(cwd)
  for (let i = 0; i < 10; i++) {
    for (const filename of CONFIG_FILES) {
      const configPath = join(dir, filename)
      if (existsSync(configPath)) {
        try {
          let content = readFileSync(configPath, 'utf-8')
          // Strip JSONC comments (// ...) — simple line-level stripping
          content = content.replace(/^\s*\/\/.*$/gm, '')
          const parsed: unknown = JSON.parse(content)
          return normalizeProjectConfig(parsed)
        } catch {
          return null
        }
      }
    }
    if (existsSync(join(dir, '.git'))) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}
