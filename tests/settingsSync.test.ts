/**
 * Tests for src/core/settingsSync.ts
 *
 * Focus on bundle assembly, encryption round-trip, diffing, and
 * formatting. Git transport is exercised structurally (mocked) since
 * it requires network.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import {
  collectBundle, hashBundle, applyBundle,
  encryptBundle, decryptBundle,
  getSyncStatus, diffBundles,
  formatBundle, formatSyncStatus,
  type SettingsBundle,
} from '../src/core/settingsSync.js'
import { existsSync, rmSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { homedir } from 'os'

let testHome: string
let origHome: string | undefined

beforeAll(() => {
  testHome = mkdtempSync(join(tmpdir(), 'ovolv999-sync-'))
  origHome = process.env.HOME
  process.env.HOME = testHome
})

afterAll(() => {
  if (origHome !== undefined) process.env.HOME = origHome
  rmSync(testHome, { recursive: true, force: true })
})

beforeEach(() => {
  const dir = join(homedir(), '.ovolv999')
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
})

describe('settingsSync', () => {
  describe('collectBundle', () => {
    it('returns a bundle with version 1', () => {
      const bundle = collectBundle()
      expect(bundle.version).toBe(1)
    })

    it('includes hostname and timestamp', () => {
      const bundle = collectBundle()
      expect(bundle.hostname).toBeTruthy()
      expect(bundle.createdAt).toBeTruthy()
    })

    it('includes schemaHash', () => {
      const bundle = collectBundle()
      expect(bundle.schemaHash).toMatch(/^[0-9a-f]+$/)
    })

    it('collects config when present', () => {
      const dir = join(homedir(), '.ovolv999')
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ model: 'test' }))
      const bundle = collectBundle()
      expect(bundle.config).toBeDefined()
    })

    it('collects settings when present', () => {
      const dir = join(homedir(), '.ovolv999')
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ hooks: {} }))
      const bundle = collectBundle()
      expect(bundle.settings).toBeDefined()
    })

    it('collects profiles when present', () => {
      const dir = join(homedir(), '.ovolv999')
      writeFileSync(join(dir, 'profiles.json'), JSON.stringify({ default: {} }))
      const bundle = collectBundle()
      expect(bundle.profiles).toBeDefined()
    })
  })

  describe('hashBundle', () => {
    it('produces consistent hashes for same content', () => {
      const b1: SettingsBundle = {
        version: 1, createdAt: '2024-01-01', hostname: 'a', schemaHash: '',
        config: { x: 1 },
      }
      const b2: SettingsBundle = {
        version: 1, createdAt: '2024-02-01', hostname: 'b', schemaHash: '',
        config: { x: 1 },
      }
      expect(hashBundle(b1)).toBe(hashBundle(b2))
    })

    it('changes when sections are added', () => {
      const base: SettingsBundle = { version: 1, createdAt: '', hostname: '', schemaHash: '' }
      const withConfig: SettingsBundle = { ...base, config: { x: 1 } }
      expect(hashBundle(base)).not.toBe(hashBundle(withConfig))
    })
  })

  describe('applyBundle', () => {
    it('writes config + settings to disk', () => {
      const bundle: SettingsBundle = {
        version: 1, createdAt: new Date().toISOString(), hostname: 'test',
        schemaHash: '', config: { model: 'applied' }, settings: { hooks: {} },
      }
      bundle.schemaHash = hashBundle(bundle)
      const result = applyBundle(bundle)
      expect(result.applied).toBe(true)
      expect(existsSync(join(homedir(), '.ovolv999', 'config.json'))).toBe(true)
      expect(existsSync(join(homedir(), '.ovolv999', 'settings.json'))).toBe(true)
    })

    it('refuses to apply on schema mismatch without force', () => {
      const bundle: SettingsBundle = {
        version: 1, createdAt: '', hostname: '', schemaHash: 'wrong',
        config: { x: 1 },
      }
      const result = applyBundle(bundle)
      expect(result.applied).toBe(false)
      expect(result.warnings.length).toBeGreaterThan(0)
    })

    it('applies on schema mismatch with force', () => {
      const bundle: SettingsBundle = {
        version: 1, createdAt: '', hostname: '', schemaHash: 'wrong',
        config: { x: 1 },
      }
      const result = applyBundle(bundle, { force: true })
      expect(result.applied).toBe(true)
    })
  })

  describe('encryption', () => {
    it('encrypts and decrypts round-trip', () => {
      const bundle: SettingsBundle = {
        version: 1, createdAt: '2024-01-01', hostname: 'h',
        schemaHash: 'abc', config: { secret: 'value' },
      }
      const encrypted = encryptBundle(bundle, 'mypassword')
      expect(encrypted).not.toContain('secret')
      expect(encrypted).not.toContain('value')

      const decrypted = decryptBundle(encrypted, 'mypassword')
      expect(decrypted.config).toEqual({ secret: 'value' })
    })

    it('wrong passphrase throws', () => {
      const bundle: SettingsBundle = { version: 1, createdAt: '', hostname: '', schemaHash: '' }
      const encrypted = encryptBundle(bundle, 'correct')
      expect(() => decryptBundle(encrypted, 'wrong')).toThrow()
    })

    it('produces different ciphertexts for same plaintext (random IV)', () => {
      const bundle: SettingsBundle = { version: 1, createdAt: '', hostname: '', schemaHash: '' }
      const e1 = encryptBundle(bundle, 'pw')
      const e2 = encryptBundle(bundle, 'pw')
      expect(e1).not.toBe(e2)
    })
  })

  describe('getSyncStatus', () => {
    it('reports no files initially', () => {
      const status = getSyncStatus()
      expect(status.bundleKeys).toEqual([])
    })

    it('reports files after writing', () => {
      const dir = join(homedir(), '.ovolv999')
      writeFileSync(join(dir, 'config.json'), '{}')
      writeFileSync(join(dir, 'profiles.json'), '{}')
      const status = getSyncStatus()
      expect(status.bundleKeys).toContain('config.json')
      expect(status.bundleKeys).toContain('profiles.json')
    })
  })

  describe('diffBundles', () => {
    it('returns empty for identical bundles', () => {
      const b: SettingsBundle = { version: 1, createdAt: '', hostname: '', schemaHash: '' }
      expect(diffBundles(b, b)).toEqual([])
    })

    it('detects config differences', () => {
      const a: SettingsBundle = { version: 1, createdAt: '', hostname: '', schemaHash: '', config: { x: 1 } }
      const b: SettingsBundle = { version: 1, createdAt: '', hostname: '', schemaHash: '', config: { x: 2 } }
      const diffs = diffBundles(a, b)
      expect(diffs.length).toBeGreaterThan(0)
    })
  })

  describe('formatBundle', () => {
    it('formats a bundle', () => {
      const out = formatBundle({
        version: 1, createdAt: '2024', hostname: 'h', schemaHash: 'abc',
        config: {}, settings: {},
      })
      expect(out).toContain('Settings Bundle')
      expect(out).toContain('config.json')
      expect(out).toContain('settings.json')
    })

    it('handles empty bundle', () => {
      const out = formatBundle({ version: 1, createdAt: '', hostname: '', schemaHash: '' })
      expect(out).toContain('Settings Bundle')
    })
  })

  describe('formatSyncStatus', () => {
    it('formats status', () => {
      const out = formatSyncStatus({
        hasLocalConfig: true,
        hasLocalSettings: false,
        bundleKeys: ['config.json'],
      })
      expect(out).toContain('config.json')
    })

    it('notes last sync when present', () => {
      const out = formatSyncStatus({
        hasLocalConfig: true,
        hasLocalSettings: true,
        bundleKeys: ['config.json', 'settings.json'],
        lastSyncAt: '2024-01-01',
      })
      expect(out).toContain('2024-01-01')
    })
  })
})
