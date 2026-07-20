import { describe, it, expect } from 'vitest'
import {
  evaluatePermission, addRule, removeRule, updateRule, findRule,
  formatPermissionResult, formatRuleList, formatPermissionSummary,
  createQuickConfig, ApprovalCache,
  DEFAULT_PERMISSION_CONFIG,
  type PermissionConfig,
} from '../src/core/permissionRules.js'
import { globMatch, globToRegexString, isValidGlob, extractGlobBase } from '../src/utils/globMatch.js'

describe('Glob Matcher', () => {
  describe('globMatch', () => {
    it('matches exact string', () => {
      expect(globMatch('foo.ts', 'foo.ts')).toBe(true)
      expect(globMatch('foo.ts', 'bar.ts')).toBe(false)
    })

    it('matches single * in filename', () => {
      expect(globMatch('*.ts', 'foo.ts')).toBe(true)
      expect(globMatch('*.ts', 'foo.js')).toBe(false)
    })

    it('matches ** recursively', () => {
      expect(globMatch('**/*.ts', 'src/foo.ts')).toBe(true)
      expect(globMatch('**/*.ts', 'src/deep/nested/foo.ts')).toBe(true)
      expect(globMatch('**/*.ts', 'foo.ts')).toBe(true)
    })

    it('matches * in path', () => {
      expect(globMatch('src/*', 'src/foo.ts')).toBe(true)
      expect(globMatch('src/*', 'src/deep/foo.ts')).toBe(false)
    })

    it('matches ? single character', () => {
      expect(globMatch('foo?.ts', 'foo1.ts')).toBe(true)
      expect(globMatch('foo?.ts', 'foo12.ts')).toBe(false)
    })

    it('matches brace expansion', () => {
      expect(globMatch('*.{ts,js}', 'foo.ts')).toBe(true)
      expect(globMatch('*.{ts,js}', 'foo.js')).toBe(true)
      expect(globMatch('*.{ts,js}', 'foo.py')).toBe(false)
    })

    it('matches brace expansion in commands', () => {
      expect(globMatch('{ls,cat,pwd}*', 'ls -la')).toBe(true)
      expect(globMatch('{ls,cat,pwd}*', 'cat file.txt')).toBe(true)
      expect(globMatch('{ls,cat,pwd}*', 'rm -rf')).toBe(false)
    })

    it('matches character classes', () => {
      expect(globMatch('foo[abc].ts', 'fooa.ts')).toBe(true)
      expect(globMatch('foo[abc].ts', 'foob.ts')).toBe(true)
      expect(globMatch('foo[abc].ts', 'food.ts')).toBe(false)
    })

    it('matches negated character classes', () => {
      expect(globMatch('foo[!abc].ts', 'food.ts')).toBe(true)
      expect(globMatch('foo[!abc].ts', 'fooa.ts')).toBe(false)
    })

    it('escapes regex special chars', () => {
      expect(globMatch('file.txt', 'file.txt')).toBe(true)
      expect(globMatch('file.txt', 'fileXtxt')).toBe(false)
      expect(globMatch('a+b', 'a+b')).toBe(true)
      expect(globMatch('a+b', 'aab')).toBe(false)
    })

    it('matches rm -rf pattern', () => {
      expect(globMatch('rm -rf **', 'rm -rf /')).toBe(true)
      expect(globMatch('rm -rf **', 'rm -rf --no-preserve-root /')).toBe(true)
      expect(globMatch('rm -rf **', 'ls -la')).toBe(false)
    })
  })

  describe('globToRegexString', () => {
    it('converts * pattern', () => {
      expect(globToRegexString('*.ts')).toContain('[^/]*')
    })

    it('converts ** pattern', () => {
      expect(globToRegexString('**/*')).toContain('.*')
    })
  })

  describe('isValidGlob', () => {
    it('validates simple patterns', () => {
      expect(isValidGlob('*.ts')).toBe(true)
      expect(isValidGlob('**/*.js')).toBe(true)
    })

    it('validates brace patterns', () => {
      expect(isValidGlob('*.{ts,js}')).toBe(true)
    })
  })

  describe('extractGlobBase', () => {
    it('extracts base directory', () => {
      const { base, rest } = extractGlobBase('src/**/*.ts')
      expect(base).toBe('src')
      expect(rest).toBe('**/*.ts')
    })

    it('handles no wildcard', () => {
      const { base, rest } = extractGlobBase('src/foo.ts')
      expect(base).toBe('src/foo.ts')
      expect(rest).toBe('')
    })

    it('handles wildcard at start', () => {
      const { base, rest } = extractGlobBase('*.ts')
      expect(base).toBe('')
      expect(rest).toBe('*.ts')
    })
  })
})

describe('Enhanced Permission Rules', () => {
  describe('evaluatePermission', () => {
    it('allows read operations by default', () => {
      const result = evaluatePermission('Read', '/path/to/file.ts')
      expect(result.decision).toBe('allow')
    })

    it('allows glob/grep operations', () => {
      expect(evaluatePermission('Glob', '**/*.ts').decision).toBe('allow')
      expect(evaluatePermission('Grep', 'pattern').decision).toBe('allow')
    })

    it('allows safe bash commands', () => {
      expect(evaluatePermission('Bash', 'ls -la').decision).toBe('allow')
      expect(evaluatePermission('Bash', 'git status').decision).toBe('allow')
      expect(evaluatePermission('Bash', 'git log --oneline').decision).toBe('allow')
    })

    it('denies rm -rf', () => {
      const result = evaluatePermission('Bash', 'rm -rf /')
      expect(result.decision).toBe('deny')
      expect(result.reason).toContain('recursive delete')
    })

    it('denies sudo', () => {
      const result = evaluatePermission('Bash', 'sudo apt install')
      expect(result.decision).toBe('deny')
    })

    it('denies force push', () => {
      const result = evaluatePermission('Bash', 'git push --force origin main')
      expect(result.decision).toBe('deny')
    })

    it('denies writing to .env files', () => {
      const result = evaluatePermission('Write', '/project/.env')
      expect(result.decision).toBe('deny')
      expect(result.reason).toContain('environment')
    })

    it('denies writing to key files', () => {
      expect(evaluatePermission('Write', '/project/private.key').decision).toBe('deny')
      expect(evaluatePermission('Write', '/project/cert.pem').decision).toBe('deny')
    })

    it('asks for unknown tools', () => {
      const config: PermissionConfig = { defaultDecision: 'ask', rules: [] }
      const result = evaluatePermission('UnknownTool', 'arg', config)
      expect(result.decision).toBe('ask')
    })

    it('respects priority order', () => {
      const config: PermissionConfig = {
        defaultDecision: 'ask',
        rules: [
          { id: 'low', tool: 'Bash', pattern: '*', decision: 'allow', priority: 1 },
          { id: 'high', tool: 'Bash', pattern: 'dangerous', decision: 'deny', priority: 100 },
        ],
      }
      expect(evaluatePermission('Bash', 'safe', config).decision).toBe('allow')
      expect(evaluatePermission('Bash', 'dangerous', config).decision).toBe('deny')
    })

    it('matches tool patterns with braces', () => {
      const config: PermissionConfig = {
        defaultDecision: 'deny',
        rules: [
          { id: 'multi', tool: '{Read,Write,Edit}', pattern: '**', decision: 'allow', priority: 0 },
        ],
      }
      expect(evaluatePermission('Read', 'foo', config).decision).toBe('allow')
      expect(evaluatePermission('Write', 'foo', config).decision).toBe('allow')
      expect(evaluatePermission('Bash', 'foo', config).decision).toBe('deny')
    })

    it('matches tool with comma-separated list', () => {
      const config: PermissionConfig = {
        defaultDecision: 'deny',
        rules: [
          { id: 'multi', tool: 'Read, Write, Edit', pattern: '**', decision: 'allow', priority: 0 },
        ],
      }
      expect(evaluatePermission('Read', 'foo', config).decision).toBe('allow')
    })

    it('matches all tools with *', () => {
      const config: PermissionConfig = {
        defaultDecision: 'deny',
        rules: [
          { id: 'all', tool: '*', pattern: '**', decision: 'allow', priority: 0 },
        ],
      }
      expect(evaluatePermission('AnyTool', 'anything', config).decision).toBe('allow')
    })
  })

  describe('addRule', () => {
    it('adds a rule with auto-generated id', () => {
      const config = addRule(DEFAULT_PERMISSION_CONFIG, {
        tool: 'Bash',
        pattern: 'npm *',
        decision: 'allow',
      })
      const rule = config.rules.find(r => r.pattern === 'npm *')
      expect(rule).toBeDefined()
      expect(rule?.id).toMatch(/^rule_/)
    })

    it('adds a rule with custom id', () => {
      const config = addRule(DEFAULT_PERMISSION_CONFIG, {
        id: 'my-rule',
        tool: 'Bash',
        pattern: 'npm *',
        decision: 'allow',
      })
      expect(findRule(config, 'my-rule')).not.toBeNull()
    })

    it('does not mutate original config', () => {
      const original = DEFAULT_PERMISSION_CONFIG
      const config = addRule(original, { tool: 'X', pattern: 'y', decision: 'allow' })
      expect(config.rules.length).toBe(original.rules.length + 1)
    })
  })

  describe('removeRule', () => {
    it('removes a rule by id', () => {
      const config = removeRule(DEFAULT_PERMISSION_CONFIG, 'deny-rm-rf')
      expect(findRule(config, 'deny-rm-rf')).toBeNull()
    })

    it('returns config unchanged for missing rule', () => {
      const config = removeRule(DEFAULT_PERMISSION_CONFIG, 'nope')
      expect(config.rules.length).toBe(DEFAULT_PERMISSION_CONFIG.rules.length)
    })
  })

  describe('updateRule', () => {
    it('updates a rule', () => {
      const config = updateRule(DEFAULT_PERMISSION_CONFIG, 'deny-rm-rf', {
        reason: 'Updated reason',
      })
      expect(findRule(config, 'deny-rm-rf')?.reason).toBe('Updated reason')
    })
  })

  describe('findRule', () => {
    it('finds existing rule', () => {
      expect(findRule(DEFAULT_PERMISSION_CONFIG, 'read-all')).not.toBeNull()
    })

    it('returns null for missing rule', () => {
      expect(findRule(DEFAULT_PERMISSION_CONFIG, 'nope')).toBeNull()
    })
  })

  describe('ApprovalCache', () => {
    it('approves and checks', () => {
      const cache = new ApprovalCache()
      cache.approve('Bash', 'npm *')
      expect(cache.isApproved('Bash', 'npm test')).toBe(true)
      expect(cache.isApproved('Bash', 'rm -rf')).toBe(false)
    })

    it('clears approvals', () => {
      const cache = new ApprovalCache()
      cache.approve('Bash', 'npm *')
      cache.clear()
      expect(cache.isApproved('Bash', 'npm test')).toBe(false)
    })

    it('lists approvals', () => {
      const cache = new ApprovalCache()
      cache.approve('Bash', 'npm *')
      cache.approve('Write', '*.ts')
      expect(cache.list()).toHaveLength(2)
    })
  })

  describe('formatting', () => {
    it('formatPermissionResult shows decision', () => {
      const result = evaluatePermission('Read', 'foo.ts')
      const out = formatPermissionResult(result)
      expect(out).toContain('ALLOW')
    })

    it('formatRuleList shows all rules', () => {
      const out = formatRuleList(DEFAULT_PERMISSION_CONFIG)
      expect(out).toContain('Permission rules')
      expect(out).toContain('read-all')
      expect(out).toContain('deny-rm-rf')
      expect(out).toContain('Default:')
    })

    it('formatRuleList shows empty config', () => {
      const out = formatRuleList({ defaultDecision: 'ask', rules: [] })
      expect(out).toContain('(0)')
    })

    it('formatPermissionSummary shows counts', () => {
      const out = formatPermissionSummary(DEFAULT_PERMISSION_CONFIG)
      expect(out).toContain('Total rules')
      expect(out).toContain('Allow')
      expect(out).toContain('Deny')
    })
  })

  describe('createQuickConfig', () => {
    it('creates config with custom rules', () => {
      const config = createQuickConfig('ask', [
        { tool: 'Bash', pattern: 'npm *', decision: 'allow' },
        { tool: 'Bash', pattern: 'rm *', decision: 'deny' },
      ])
      expect(config.rules).toHaveLength(2)
      expect(config.defaultDecision).toBe('ask')
    })
  })
})
