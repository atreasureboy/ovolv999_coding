import { describe, it, expect } from 'vitest'
import {
  scanForSecrets,
  maskSecrets,
  hasSecrets,
  fingerprintSecret,
  formatScanSummary,
  isValidSecret,
  maskKey,
} from '../src/utils/secretScanner.js'

describe('secretScanner', () => {
  describe('maskKey', () => {
    it('masks long keys showing first 4 and last 4', () => {
      expect(maskKey('sk-abcdefghij1234567890wxyz')).toBe('sk-a...wxyz')
    })

    it('fully masks short strings', () => {
      expect(maskKey('short')).toBe('***REDACTED***')
    })

    it('handles exactly 12 chars', () => {
      expect(maskKey('123456789012')).toBe('***REDACTED***')
    })

    it('handles 13 chars', () => {
      expect(maskKey('1234567890123')).toBe('1234...0123')
    })
  })

  describe('scanForSecrets', () => {
    it('detects OpenAI API keys', () => {
      const text = 'const key = "sk-abcdefghijklmnopqrstuvwxyz1234567890"'
      const matches = scanForSecrets(text)
      expect(matches.length).toBe(1)
      expect(matches[0].type).toBe('OpenAI API key')
      expect(matches[0].fullMatch).toContain('sk-')
    })

    it('detects Anthropic API keys', () => {
      const text = 'ANTHROPIC_API_KEY=sk-ant-api03-1234567890abcdefghijklmnop'
      const matches = scanForSecrets(text)
      expect(matches.length).toBeGreaterThanOrEqual(1)
      expect(matches.some(m => m.type === 'Anthropic API key')).toBe(true)
    })

    it('detects AWS access keys', () => {
      const text = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE'
      const matches = scanForSecrets(text)
      expect(matches.some(m => m.type === 'AWS access key')).toBe(true)
    })

    it('detects GitHub tokens', () => {
      const text = 'GITHUB_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyz'
      const matches = scanForSecrets(text)
      expect(matches.some(m => m.type === 'GitHub token')).toBe(true)
    })

    it('detects Slack tokens', () => {
      const text = 'SLACK_BOT_TOKEN=xoxb-1234567890-1234567890-abcdefghij'
      const matches = scanForSecrets(text)
      expect(matches.some(m => m.type === 'Slack token')).toBe(true)
    })

    it('detects Google API keys', () => {
      const text = 'GOOGLE_API_KEY=AIzaSyABCDEFGHIJKLMNopqrstuvwxyz1234567890ab'
      const matches = scanForSecrets(text)
      expect(matches.some(m => m.type === 'Google API key')).toBe(true)
    })

    it('detects JWT tokens', () => {
      const text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456'
      const matches = scanForSecrets(text)
      expect(matches.some(m => m.type === 'JWT token' || m.type === 'Bearer token')).toBe(true)
    })

    it('detects private keys', () => {
      const text = `config = """
-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA1234567890abcdefghijklmnopqrstuvwxyz
-----END RSA PRIVATE KEY-----
"""`
      const matches = scanForSecrets(text)
      expect(matches.some(m => m.type === 'Private key')).toBe(true)
    })

    it('detects generic api_key= pattern', () => {
      const text = 'api_key=abcdef1234567890abcdefghij'
      const matches = scanForSecrets(text)
      expect(matches.some(m => m.type === 'Generic API key assignment')).toBe(true)
    })

    it('detects connection strings', () => {
      const text = 'DATABASE_URL=postgres://user:secretpass@localhost:5432/db'
      const matches = scanForSecrets(text)
      expect(matches.some(m => m.type === 'Connection string')).toBe(true)
    })

    it('returns empty for clean text', () => {
      const text = 'const x = 1 + 2\nconsole.log(x)'
      expect(scanForSecrets(text)).toEqual([])
    })

    it('sorts matches by position', () => {
      const text = 'key1=sk-abcdefghijklmnopqrstuvwxyz1234567890 key2=AKIAIOSFODNN7EXAMPLE'
      const matches = scanForSecrets(text)
      expect(matches.length).toBeGreaterThanOrEqual(2)
      for (let i = 1; i < matches.length; i++) {
        expect(matches[i].start).toBeGreaterThanOrEqual(matches[i - 1].end)
      }
    })

    it('removes overlapping matches', () => {
      const text = 'token=sk-abcdefghijklmnopqrstuvwxyz1234567890'
      const matches = scanForSecrets(text)
      // Should not have overlapping ranges
      for (let i = 1; i < matches.length; i++) {
        expect(matches[i].start).toBeGreaterThanOrEqual(matches[i - 1].end)
      }
    })

    it('provides correct start/end indices', () => {
      const text = 'prefix sk-abcdefghijklmnopqrstuvwxyz1234567890 suffix'
      const matches = scanForSecrets(text)
      expect(matches.length).toBeGreaterThanOrEqual(1)
      const m = matches[0]
      expect(text.slice(m.start, m.end)).toBe(m.fullMatch)
    })
  })

  describe('maskSecrets', () => {
    it('returns text unchanged when no secrets', () => {
      const result = maskSecrets('hello world')
      expect(result.found).toBe(false)
      expect(result.masked).toBe('hello world')
      expect(result.count).toBe(0)
    })

    it('masks OpenAI key in text', () => {
      const original = 'key = "sk-abcdefghijklmnopqrstuvwxyz1234567890"'
      const result = maskSecrets(original)
      expect(result.found).toBe(true)
      expect(result.count).toBeGreaterThanOrEqual(1)
      expect(result.masked).not.toBe(original)
      expect(result.masked).not.toContain('sk-abcdefghijklmnopqrstuvwxyz1234567890')
      expect(result.masked).toContain('...')
    })

    it('masks multiple secrets', () => {
      const text = 'OPENAI_KEY=sk-abcdefghijklmnopqrstuvwxyz1234567890 AWS_KEY=AKIAIOSFODNN7EXAMPLE'
      const result = maskSecrets(text)
      expect(result.count).toBeGreaterThanOrEqual(2)
    })

    it('preserves non-secret content', () => {
      const text = 'const greeting = "hello"; const key = "sk-abcdefghijklmnopqrstuvwxyz1234567890"; const x = 42'
      const result = maskSecrets(text)
      expect(result.masked).toContain('greeting')
      expect(result.masked).toContain('hello')
      expect(result.masked).toContain('42')
    })

    it('handles empty string', () => {
      const result = maskSecrets('')
      expect(result.found).toBe(false)
      expect(result.masked).toBe('')
    })

    it('masks private key blocks', () => {
      const text = `key = """-----BEGIN PRIVATE KEY-----
MIIEpAIBAAKCAQEA1234567890
-----END PRIVATE KEY-----"""`
      const result = maskSecrets(text)
      expect(result.found).toBe(true)
      expect(result.masked).toContain('REDACTED')
      expect(result.masked).not.toContain('MIIEpAIBAAKCAQEA')
    })
  })

  describe('hasSecrets', () => {
    it('returns true when secrets present', () => {
      expect(hasSecrets('sk-abcdefghijklmnopqrstuvwxyz1234567890')).toBe(true)
    })

    it('returns false for clean text', () => {
      expect(hasSecrets('hello world')).toBe(false)
    })

    it('returns false for empty string', () => {
      expect(hasSecrets('')).toBe(false)
    })
  })

  describe('fingerprintSecret', () => {
    it('returns 16-char hex string', () => {
      const fp = fingerprintSecret('sk-test1234567890')
      expect(fp).toMatch(/^[a-f0-9]{16}$/)
    })

    it('is deterministic', () => {
      expect(fingerprintSecret('same-key')).toBe(fingerprintSecret('same-key'))
    })

    it('differs for different inputs', () => {
      expect(fingerprintSecret('key-a')).not.toBe(fingerprintSecret('key-b'))
    })
  })

  describe('formatScanSummary', () => {
    it('returns "no secrets" message for clean text', () => {
      const result = maskSecrets('clean text')
      expect(formatScanSummary(result)).toContain('No secrets')
    })

    it('lists found secret types', () => {
      const result = maskSecrets('sk-abcdefghijklmnopqrstuvwxyz1234567890')
      const summary = formatScanSummary(result)
      expect(summary).toContain('Found')
      expect(summary).toContain('secret(s)')
    })

    it('groups by type', () => {
      const text = 'a=sk-abcdefghijklmnopqrstuvwxyz1234567890 b=sk-zyxwvutsrqponmlkjihgfedcba0987654321'
      const result = maskSecrets(text)
      const summary = formatScanSummary(result)
      expect(summary).toContain('OpenAI API key: 2')
    })
  })

  describe('isValidSecret', () => {
    it('returns false for short strings', () => {
      expect(isValidSecret('short')).toBe(false)
    })

    it('returns false for low-entropy strings', () => {
      expect(isValidSecret('aaaaaaaaaaaaaaaa')).toBe(false)
    })

    it('returns true for realistic secrets', () => {
      expect(isValidSecret('sk-abc123def456ghi789')).toBe(true)
    })
  })
})
