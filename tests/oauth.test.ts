/**
 * Tests for src/core/oauth.ts
 *
 * Avoids real network/HTTP — tests PKCE/state building, token storage,
 * elicitation lifecycle, and formatting. The full authorize() flow is
 * exercised only structurally (it requires a real callback server).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import {
  generatePKCE,
  generateState,
  buildAuthorizationUrl,
  saveToken,
  loadToken,
  deleteToken,
  isTokenExpired,
  createElicitation,
  respondToElicitation,
  getPendingElicitations,
  cancelElicitation,
  formatTokenInfo,
  formatElicitationRequest,
  type OAuthConfig,
  type OAuthToken,
} from '../src/core/oauth.js'
import { existsSync, rmSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { homedir } from 'os'

let testHome: string
let origHome: string | undefined

beforeAll(() => {
  testHome = mkdtempSync(join(tmpdir(), 'ovolv999-oauth-'))
  origHome = process.env.HOME
  process.env.HOME = testHome
})

afterAll(() => {
  if (origHome !== undefined) process.env.HOME = origHome
  rmSync(testHome, { recursive: true, force: true })
})

beforeEach(() => {
  const dir = join(homedir(), '.ovolv999', 'oauth-tokens')
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
})

const sampleConfig: OAuthConfig = {
  clientId: 'test-client',
  clientSecret: 'secret',
  authorizationEndpoint: 'https://example.com/auth',
  tokenEndpoint: 'https://example.com/token',
  redirectUri: 'http://localhost:8765/callback',
  scopes: ['read', 'write'],
  serverName: 'test-server',
}

describe('oauth', () => {
  describe('PKCE', () => {
    it('generates verifier and S256 challenge', () => {
      const pkce = generatePKCE()
      expect(pkce.verifier.length).toBeGreaterThan(20)
      expect(pkce.challenge.length).toBeGreaterThan(20)
      expect(pkce.method).toBe('S256')
      expect(pkce.verifier).not.toBe(pkce.challenge)
    })

    it('generates unique values each call', () => {
      const a = generatePKCE()
      const b = generatePKCE()
      expect(a.verifier).not.toBe(b.verifier)
    })
  })

  describe('generateState', () => {
    it('returns a hex string', () => {
      const s = generateState()
      expect(s).toMatch(/^[0-9a-f]+$/)
      expect(s.length).toBe(32)
    })

    it('is unique', () => {
      expect(generateState()).not.toBe(generateState())
    })
  })

  describe('buildAuthorizationUrl', () => {
    it('includes required params', () => {
      const state = 'abc123'
      const url = buildAuthorizationUrl(sampleConfig, state)
      expect(url).toContain('response_type=code')
      expect(url).toContain('client_id=test-client')
      expect(url).toContain(`state=${state}`)
      expect(url).toContain('scope=read+write')
      expect(url.startsWith('https://example.com/auth?')).toBe(true)
    })

    it('includes PKCE challenge when provided', () => {
      const pkce = generatePKCE()
      const url = buildAuthorizationUrl(sampleConfig, 's', pkce)
      expect(url).toContain('code_challenge=')
      expect(url).toContain('code_challenge_method=S256')
    })

    it('omits PKCE when not provided', () => {
      const url = buildAuthorizationUrl(sampleConfig, 's')
      expect(url).not.toContain('code_challenge')
    })

    it('appends with & when endpoint already has ?', () => {
      const cfg = { ...sampleConfig, authorizationEndpoint: 'https://example.com/auth?foo=bar' }
      const url = buildAuthorizationUrl(cfg, 's')
      expect(url).toContain('?foo=bar&')
    })
  })

  describe('token storage', () => {
    const sampleToken: OAuthToken = {
      accessToken: 'access-123',
      refreshToken: 'refresh-456',
      expiresAt: Date.now() + 3600_000,
      tokenType: 'Bearer',
      scope: 'read write',
    }

    it('returns null when no token stored', () => {
      expect(loadToken('nope')).toBeNull()
    })

    it('saves and loads a token', () => {
      saveToken('srv', sampleToken)
      const loaded = loadToken('srv')
      expect(loaded).not.toBeNull()
      expect(loaded!.accessToken).toBe('access-123')
      expect(loaded!.refreshToken).toBe('refresh-456')
    })

    it('deleteToken removes the token', () => {
      saveToken('srv', sampleToken)
      expect(loadToken('srv')).not.toBeNull()
      expect(deleteToken('srv')).toBe(true)
      // After delete the file is empty → loadToken returns null
      expect(loadToken('srv')).toBeNull()
    })

    it('deleteToken returns false when nothing to delete', () => {
      expect(deleteToken('never-existed')).toBe(false)
    })
  })

  describe('isTokenExpired', () => {
    it('returns false when no expiresAt', () => {
      expect(isTokenExpired({ accessToken: 'x', tokenType: 'Bearer' })).toBe(false)
    })

    it('returns false when expiry is in the future', () => {
      expect(isTokenExpired({ accessToken: 'x', tokenType: 'Bearer', expiresAt: Date.now() + 600_000 })).toBe(false)
    })

    it('returns true when expiry is in the past', () => {
      expect(isTokenExpired({ accessToken: 'x', tokenType: 'Bearer', expiresAt: Date.now() - 1000 })).toBe(true)
    })

    it('returns true within leeway window', () => {
      const expiresAt = Date.now() + 30_000 // 30s
      expect(isTokenExpired({ accessToken: 'x', tokenType: 'Bearer', expiresAt }, 60_000)).toBe(true)
    })
  })

  describe('elicitation lifecycle', () => {
    it('createElicitation returns id and pending promise', () => {
      const { id, promise } = createElicitation('srv', 'Please confirm', { type: 'string' })
      expect(id).toMatch(/^elicit-/)
      expect(promise).toBeInstanceOf(Promise)
    })

    it('respondToElicitation resolves the promise with accept', async () => {
      const { id, promise } = createElicitation('srv', 'msg', {})
      const ok = respondToElicitation({ id, action: 'accept', data: { answer: 42 } })
      expect(ok).toBe(true)
      const result = await promise
      expect(result.action).toBe('accept')
      expect(result.data).toEqual({ answer: 42 })
    })

    it('respondToElicitation resolves with decline', async () => {
      const { id, promise } = createElicitation('srv', 'msg', {})
      respondToElicitation({ id, action: 'decline' })
      const result = await promise
      expect(result.action).toBe('decline')
    })

    it('respondToElicitation returns false for unknown id', () => {
      expect(respondToElicitation({ id: 'nope', action: 'cancel' })).toBe(false)
    })

    it('getPendingElicitations lists outstanding requests', () => {
      createElicitation('srv-a', 'one', {})
      createElicitation('srv-b', 'two', {})
      const pending = getPendingElicitations()
      expect(pending.length).toBeGreaterThanOrEqual(2)
      expect(pending.some((p) => p.serverName === 'srv-a')).toBe(true)
      expect(pending.some((p) => p.serverName === 'srv-b')).toBe(true)
    })

    it('cancelElicitation resolves with cancel action', async () => {
      const { id, promise } = createElicitation('srv', 'msg', {})
      expect(cancelElicitation(id)).toBe(true)
      const result = await promise
      expect(result.action).toBe('cancel')
    })

    it('cancelElicitation returns false for unknown id', () => {
      expect(cancelElicitation('nope')).toBe(false)
    })
  })

  describe('formatTokenInfo', () => {
    it('formats a token with all fields', () => {
      const out = formatTokenInfo({
        accessToken: 'abcdefgh12345',
        refreshToken: 'r',
        expiresAt: Date.now() + 600_000,
        tokenType: 'Bearer',
        scope: 'read',
      })
      expect(out).toContain('Bearer')
      expect(out).toContain('abcdefgh')
      expect(out).toContain('min')
      expect(out).toContain('Refresh')
      expect(out).toContain('read')
    })

    it('handles token without optional fields', () => {
      const out = formatTokenInfo({ accessToken: 'abc12345', tokenType: 'Bearer' })
      expect(out).toContain('Bearer')
    })
  })

  describe('formatElicitationRequest', () => {
    it('formats a request', () => {
      const out = formatElicitationRequest({
        id: 'x',
        message: 'confirm',
        requestedSchema: { type: 'string' },
        serverName: 'srv',
      })
      expect(out).toContain('srv')
      expect(out).toContain('confirm')
    })
  })
})
