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
import { join, dirname } from 'path'

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

export function loadProjectConfig(cwd: string): ProjectConfig | null {
  let dir = cwd
  for (let i = 0; i < 10; i++) {
    for (const filename of CONFIG_FILES) {
      const configPath = join(dir, filename)
      if (existsSync(configPath)) {
        try {
          let content = readFileSync(configPath, 'utf-8')
          // Strip JSONC comments (// ...) — simple line-level stripping
          content = content.replace(/^\s*\/\/.*$/gm, '')
          const parsed: unknown = JSON.parse(content)
          return parsed as ProjectConfig
        } catch {
          return null
        }
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}
