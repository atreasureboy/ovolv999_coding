/**
 * Profile Manager
 *
 * Manage multiple configuration profiles (e.g., work vs personal,
 * different API providers, different permission levels).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { isRecord } from './persistedData.js'

// ── Types ───────────────────────────────────────────────────────────────────

export interface Profile {
  /** Unique name */
  name: string
  /** Display name */
  displayName?: string
  /** Description */
  description?: string
  /** Provider configuration */
  provider?: {
    name: string
    model?: string
    apiKeyEnv?: string
    baseUrl?: string
  }
  /** Permission level */
  permissionLevel?: 'strict' | 'normal' | 'permissive'
  /** Model preferences */
  modelPrefs?: {
    temperature?: number
    maxTokens?: number
    systemPrompt?: string
  }
  /** UI preferences */
  uiPrefs?: {
    theme?: string
    showTokens?: boolean
    showCost?: boolean
    vim?: boolean
  }
  /** Environment variable overrides */
  env?: Record<string, string>
  /** Whether this is the active profile */
  active?: boolean
  /** When created */
  createdAt: string
  /** Custom metadata */
  metadata?: Record<string, unknown>
}

export interface ProfileStore {
  profiles: Record<string, Profile>
  activeProfile: string | null
}

function hasOptionalFields(value: Record<string, unknown>, keys: string[], type: 'string' | 'boolean'): boolean {
  return keys.every(key => value[key] === undefined || typeof value[key] === type)
}

function isProfile(value: unknown): value is Profile {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name.trim() || typeof value.createdAt !== 'string') return false
  if (!hasOptionalFields(value, ['displayName', 'description'], 'string') || !hasOptionalFields(value, ['active'], 'boolean')) return false
  if (value.permissionLevel !== undefined && (typeof value.permissionLevel !== 'string' || !['strict', 'normal', 'permissive'].includes(value.permissionLevel))) return false
  if (value.provider !== undefined && (!isRecord(value.provider) || typeof value.provider.name !== 'string'
    || !hasOptionalFields(value.provider, ['model', 'apiKeyEnv', 'baseUrl'], 'string'))) return false
  if (value.env !== undefined && (!isRecord(value.env) || !Object.values(value.env).every(item => typeof item === 'string'))) return false
  if (value.metadata !== undefined && !isRecord(value.metadata)) return false
  if (value.uiPrefs !== undefined && (!isRecord(value.uiPrefs) || !hasOptionalFields(value.uiPrefs, ['theme'], 'string')
    || !hasOptionalFields(value.uiPrefs, ['showTokens', 'showCost', 'vim'], 'boolean'))) return false
  if (value.modelPrefs !== undefined) {
    if (!isRecord(value.modelPrefs) || !hasOptionalFields(value.modelPrefs, ['systemPrompt'], 'string')) return false
    const { temperature, maxTokens } = value.modelPrefs
    if (temperature !== undefined && (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2)) return false
    if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || (maxTokens as number) <= 0)) return false
  }
  return true
}

// ── Persistence ─────────────────────────────────────────────────────────────

export function getProfilePath(cwd: string): string {
  return join(resolve(cwd), '.ovolv999', 'profiles.json')
}

export function loadProfiles(cwd: string): ProfileStore {
  const empty: ProfileStore = { profiles: Object.create(null) as Record<string, Profile>, activeProfile: null }
  const path = getProfilePath(cwd)
  if (!existsSync(path)) {
    return empty
  }
  try {
    const data: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!isRecord(data) || !isRecord(data.profiles)) return empty
    for (const [key, value] of Object.entries(data.profiles)) {
      if (isProfile(value) && value.name === key) {
        empty.profiles[key] = value
      }
    }
    if (typeof data.activeProfile === 'string' && Object.hasOwn(empty.profiles, data.activeProfile)) {
      empty.activeProfile = data.activeProfile
    }
    return empty
  } catch {
    return empty
  }
}

export function saveProfiles(cwd: string, store: ProfileStore): void {
  const dir = join(resolve(cwd), '.ovolv999')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(getProfilePath(cwd), JSON.stringify(store, null, 2), 'utf8')
}

// ── CRUD ────────────────────────────────────────────────────────────────────

export function createProfile(
  cwd: string,
  name: string,
  config: Partial<Omit<Profile, 'name' | 'createdAt'>> = {},
): Profile {
  const store = loadProfiles(cwd)
  const profile: Profile = {
    name,
    displayName: config.displayName,
    description: config.description,
    provider: config.provider,
    permissionLevel: config.permissionLevel ?? 'normal',
    modelPrefs: config.modelPrefs,
    uiPrefs: config.uiPrefs,
    env: config.env,
    metadata: config.metadata,
    createdAt: new Date().toISOString(),
  }

  if (!isProfile(profile)) throw new Error('Invalid profile configuration')
  store.profiles[name] = profile

  // If first profile, make it active
  if (!store.activeProfile) {
    store.activeProfile = name
  }

  saveProfiles(cwd, store)
  return profile
}

export function removeProfile(cwd: string, name: string): boolean {
  const store = loadProfiles(cwd)
  if (!store.profiles[name]) return false

  delete store.profiles[name]

  // Switch active if needed
  if (store.activeProfile === name) {
    const remaining = Object.keys(store.profiles)
    store.activeProfile = remaining[0] ?? null
  }

  saveProfiles(cwd, store)
  return true
}

export function getProfile(cwd: string, name: string): Profile | null {
  const store = loadProfiles(cwd)
  return store.profiles[name] ?? null
}

export function getActiveProfile(cwd: string): Profile | null {
  const store = loadProfiles(cwd)
  if (!store.activeProfile) return null
  return store.profiles[store.activeProfile] ?? null
}

export function setActiveProfile(cwd: string, name: string): boolean {
  const store = loadProfiles(cwd)
  if (!store.profiles[name]) return false
  store.activeProfile = name
  saveProfiles(cwd, store)
  return true
}

export function listProfiles(cwd: string): Profile[] {
  const store = loadProfiles(cwd)
  return Object.values(store.profiles)
}

export function updateProfile(
  cwd: string,
  name: string,
  updates: Partial<Profile>,
): Profile | null {
  const store = loadProfiles(cwd)
  const profile = store.profiles[name]
  if (!profile) return null

  const updated = { ...profile, ...updates, name: profile.name, createdAt: profile.createdAt }
  if (!isProfile(updated)) return null
  Object.assign(profile, updated)
  saveProfiles(cwd, store)
  return profile
}

// ── Profile Cloning ─────────────────────────────────────────────────────────

export function cloneProfile(
  cwd: string,
  sourceName: string,
  newName: string,
  overrides: Partial<Profile> = {},
): Profile | null {
  const source = getProfile(cwd, sourceName)
  if (!source) return null

  return createProfile(cwd, newName, {
    displayName: source.displayName,
    description: source.description,
    provider: source.provider ? { ...source.provider } : undefined,
    permissionLevel: source.permissionLevel,
    modelPrefs: source.modelPrefs ? { ...source.modelPrefs } : undefined,
    uiPrefs: source.uiPrefs ? { ...source.uiPrefs } : undefined,
    env: source.env ? { ...source.env } : undefined,
    metadata: source.metadata ? { ...source.metadata } : undefined,
    ...overrides,
  })
}

// ── Profile Export/Import ───────────────────────────────────────────────────

export function exportProfile(cwd: string, name: string): string | null {
  const profile = getProfile(cwd, name)
  if (!profile) return null
  return JSON.stringify(profile, null, 2)
}

export function importProfile(cwd: string, json: string, name?: string): Profile | null {
  try {
    const data = JSON.parse(json) as Profile
    const profileName = name ?? data.name
    if (!profileName) return null
    return createProfile(cwd, profileName, data)
  } catch {
    return null
  }
}

// ── Effective Configuration ─────────────────────────────────────────────────

export interface EffectiveConfig {
  provider: { name: string; model?: string; baseUrl?: string }
  permissionLevel: string
  temperature: number
  maxTokens: number | undefined
  systemPrompt: string | undefined
  env: Record<string, string>
}

const DEFAULTS: EffectiveConfig = {
  provider: { name: 'openai' },
  permissionLevel: 'normal',
  temperature: 0.7,
  maxTokens: undefined,
  systemPrompt: undefined,
  env: {},
}

export function getEffectiveConfig(cwd: string): EffectiveConfig {
  const profile = getActiveProfile(cwd)
  if (!profile) return { ...DEFAULTS, provider: { ...DEFAULTS.provider }, env: {} }

  return {
    provider: {
      name: profile.provider?.name ?? DEFAULTS.provider.name,
      model: profile.provider?.model,
      baseUrl: profile.provider?.baseUrl,
    },
    permissionLevel: profile.permissionLevel ?? DEFAULTS.permissionLevel,
    temperature: profile.modelPrefs?.temperature ?? DEFAULTS.temperature,
    maxTokens: profile.modelPrefs?.maxTokens,
    systemPrompt: profile.modelPrefs?.systemPrompt,
    env: profile.env ?? {},
  }
}

// ── Built-in Profiles ───────────────────────────────────────────────────────

export const BUILTIN_PROFILES: Array<{ name: string; config: Partial<Profile> }> = [
  {
    name: 'default',
    config: {
      displayName: 'Default',
      description: 'Balanced settings for general development',
      permissionLevel: 'normal',
      modelPrefs: { temperature: 0.7 },
    },
  },
  {
    name: 'strict',
    config: {
      displayName: 'Strict Mode',
      description: 'Maximum safety — all operations require approval',
      permissionLevel: 'strict',
      modelPrefs: { temperature: 0.3 },
    },
  },
  {
    name: 'creative',
    config: {
      displayName: 'Creative Mode',
      description: 'Higher temperature for brainstorming and exploration',
      permissionLevel: 'normal',
      modelPrefs: { temperature: 1.0 },
    },
  },
  {
    name: 'yolo',
    config: {
      displayName: 'YOLO Mode',
      description: 'Minimal confirmations — for trusted environments only',
      permissionLevel: 'permissive',
      modelPrefs: { temperature: 0.7 },
    },
  },
]

export function initializeBuiltinProfiles(cwd: string): Profile[] {
  return BUILTIN_PROFILES.map(({ name, config }) =>
    createProfile(cwd, name, config),
  )
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatProfile(profile: Profile): string {
  const lines: string[] = [
    `Profile: ${profile.displayName ?? profile.name}${profile.active ? ' (active)' : ''}`,
  ]
  if (profile.description) lines.push(`  ${profile.description}`)

  if (profile.provider) {
    lines.push(`  Provider: ${profile.provider.name}`)
    if (profile.provider.model) lines.push(`  Model: ${profile.provider.model}`)
    if (profile.provider.baseUrl) lines.push(`  Base URL: ${profile.provider.baseUrl}`)
  }

  if (profile.permissionLevel) {
    lines.push(`  Permission: ${profile.permissionLevel}`)
  }

  if (profile.modelPrefs) {
    if (profile.modelPrefs.temperature !== undefined) {
      lines.push(`  Temperature: ${profile.modelPrefs.temperature}`)
    }
    if (profile.modelPrefs.maxTokens !== undefined) {
      lines.push(`  Max Tokens: ${profile.modelPrefs.maxTokens}`)
    }
  }

  if (profile.uiPrefs) {
    const prefStrs: string[] = []
    if (profile.uiPrefs.theme) prefStrs.push(`theme=${profile.uiPrefs.theme}`)
    if (profile.uiPrefs.vim !== undefined) prefStrs.push(`vim=${profile.uiPrefs.vim}`)
    if (prefStrs.length > 0) lines.push(`  UI: ${prefStrs.join(', ')}`)
  }

  if (profile.env && Object.keys(profile.env).length > 0) {
    lines.push(`  Env vars: ${Object.keys(profile.env).join(', ')}`)
  }

  return lines.join('\n')
}

export function formatProfileList(profiles: Profile[], activeName?: string | null): string {
  if (profiles.length === 0) return 'No profiles configured.'

  const lines: string[] = [`Profiles (${profiles.length}):`]
  for (const p of profiles) {
    const active = p.name === activeName ? ' ← active' : ''
    const display = p.displayName ? ` (${p.displayName})` : ''
    const provider = p.provider ? ` [${p.provider.name}]` : ''
    const perm = p.permissionLevel ? ` {${p.permissionLevel}}` : ''
    lines.push(`  ${p.name}${display}${provider}${perm}${active}`)
  }

  return lines.join('\n')
}

export function formatEffectiveConfig(config: EffectiveConfig): string {
  const lines: string[] = [
    'Effective Configuration:',
    `  Provider: ${config.provider.name}`,
  ]
  if (config.provider.model) lines.push(`  Model: ${config.provider.model}`)
  if (config.provider.baseUrl) lines.push(`  Base URL: ${config.provider.baseUrl}`)
  lines.push(`  Permission: ${config.permissionLevel}`)
  lines.push(`  Temperature: ${config.temperature}`)
  if (config.maxTokens) lines.push(`  Max Tokens: ${config.maxTokens}`)
  if (config.systemPrompt) lines.push(`  System Prompt: (custom)`)
  if (Object.keys(config.env).length > 0) {
    lines.push(`  Env: ${Object.keys(config.env).join(', ')}`)
  }
  return lines.join('\n')
}
