/**
 * Tests for src/utils/systemHealth.ts
 *
 * Most checks shell out to the system and are environment-dependent.
 * We test the structural contract (returns a report with checks,
 * summary tallies match, format is non-empty) rather than asserting
 * specific check outcomes.
 */

import { describe, it, expect } from 'vitest'
import {
  runSystemHealthChecks,
  formatSystemHealth,
  type CheckLevel,
} from '../src/utils/systemHealth.js'

describe('systemHealth', () => {
  describe('runSystemHealthChecks', () => {
    it('returns a report', () => {
      const report = runSystemHealthChecks()
      expect(report).toBeDefined()
      expect(report.checks).toBeInstanceOf(Array)
      expect(report.checks.length).toBeGreaterThan(0)
    })

    it('includes 13 checks', () => {
      const report = runSystemHealthChecks()
      expect(report.checks.length).toBe(13)
    })

    it('every check has required fields', () => {
      const report = runSystemHealthChecks()
      for (const c of report.checks) {
        expect(typeof c.name).toBe('string')
        expect(c.name.length).toBeGreaterThan(0)
        expect(typeof c.message).toBe('string')
        const validLevels: CheckLevel[] = ['ok', 'warning', 'error', 'info']
        expect(validLevels).toContain(c.level)
      }
    })

    it('summary tallies match the checks array', () => {
      const report = runSystemHealthChecks()
      const okCount = report.checks.filter((c) => c.level === 'ok').length
      const warnCount = report.checks.filter((c) => c.level === 'warning').length
      const errCount = report.checks.filter((c) => c.level === 'error').length
      const infoCount = report.checks.filter((c) => c.level === 'info').length
      expect(report.summary.ok).toBe(okCount)
      expect(report.summary.warnings).toBe(warnCount)
      expect(report.summary.errors).toBe(errCount)
      expect(report.summary.infos).toBe(infoCount)
    })

    it('check names are unique', () => {
      const report = runSystemHealthChecks()
      const names = report.checks.map((c) => c.name)
      expect(new Set(names).size).toBe(names.length)
    })

    it('exposes environment info', () => {
      const report = runSystemHealthChecks()
      const env = report.environment
      expect(env).toBeDefined()
      expect(typeof env.platform).toBe('string')
      expect(typeof env.nodeVersion).toBe('string')
      expect(typeof env.memoryTotalMB).toBe('number')
      expect(env.memoryTotalMB).toBeGreaterThan(0)
    })
  })

  describe('formatSystemHealth', () => {
    it('produces a non-empty string', () => {
      const out = formatSystemHealth(runSystemHealthChecks())
      expect(typeof out).toBe('string')
      expect(out.length).toBeGreaterThan(20)
    })

    it('includes the header', () => {
      const out = formatSystemHealth(runSystemHealthChecks())
      expect(out).toContain('System Health')
    })

    it('includes environment block', () => {
      const out = formatSystemHealth(runSystemHealthChecks())
      expect(out).toContain('Environment')
      expect(out).toMatch(/Platform/)
    })

    it('includes summary line', () => {
      const out = formatSystemHealth(runSystemHealthChecks())
      expect(out).toMatch(/Summary/)
    })

    it('lists every check name', () => {
      const report = runSystemHealthChecks()
      const out = formatSystemHealth(report)
      for (const c of report.checks) {
        expect(out).toContain(c.name)
      }
    })
  })
})
