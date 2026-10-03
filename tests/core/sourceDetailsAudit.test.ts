import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTask, getNextRun, loadSchedules, parseCron, parseEveryDuration, parseField } from '../../src/core/cron.js'
import { createProfile, getEffectiveConfig, importProfile, loadProfiles, updateProfile } from '../../src/core/profiles.js'
import { snipCompact, snipString } from '../../src/core/snipCompact.js'

describe('source detail boundaries', () => {
  let cwd: string
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'source-details-')) })
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }) })

  it.each(['5junk', '*/2junk', '1-3/2/3', '1-3-4', '1-1000000'])('rejects malformed or unbounded cron field %s', field => {
    expect(() => parseField(field, 'minute', 0, 59)).toThrow()
  })

  it.each(['@every -5m', '@every 1h junk', '@every 5junk', '@every 1.5m'])('rejects partially parsed duration %s', expression => {
    expect(() => parseEveryDuration(expression)).toThrow()
  })

  it('treats weekday seven as Sunday when finding the next run', () => {
    const next = getNextRun(parseCron('0 0 * * 7'), new Date(2024, 0, 15, 10))
    expect(next.getDay()).toBe(0)
    expect(next.getDate()).toBe(21)
  })

  it('finds the next leap day across several years', () => {
    const next = getNextRun(parseCron('0 0 29 2 *'), new Date(2024, 2, 1))
    expect([next.getFullYear(), next.getMonth(), next.getDate()]).toEqual([2028, 1, 29])
  })

  it('preserves healthy schedules beside malformed rows', () => {
    const task = createTask('valid', '@daily', 'hello')
    mkdirSync(join(cwd, '.ovolv999'))
    writeFileSync(join(cwd, '.ovolv999', 'schedules.json'), JSON.stringify({ tasks: [null, { id: 'bad' }, task] }))
    expect(loadSchedules(cwd).tasks).toEqual([task])
  })

  it('rejects invalid nested profile data without discarding a healthy profile', () => {
    createProfile(cwd, 'healthy', { env: { KEY: 'value' } })
    const store = loadProfiles(cwd)
    writeFileSync(join(cwd, '.ovolv999', 'profiles.json'), JSON.stringify({ ...store, profiles: {
      ...store.profiles,
      broken: { name: 'broken', createdAt: new Date().toISOString(), modelPrefs: { temperature: 'hot' }, env: [] },
    } }))
    expect(Object.keys(loadProfiles(cwd).profiles)).toEqual(['healthy'])
    expect(getEffectiveConfig(cwd).env).toEqual({ KEY: 'value' })
  })

  it('rejects an import with an invalid provider', () => {
    expect(importProfile(cwd, JSON.stringify({ name: 'bad', provider: { name: 1 } }))).toBeNull()
    expect(Object.keys(loadProfiles(cwd).profiles)).toEqual([])
  })

  it('preserves profile identity when updating settings', () => {
    createProfile(cwd, 'work')
    updateProfile(cwd, 'work', { name: 'renamed', description: 'updated' })
    expect(loadProfiles(cwd).profiles.work.name).toBe('work')
    expect(loadProfiles(cwd).profiles.work.description).toBe('updated')
  })

  it.each([0, 10, 100, 3000])('obeys the explicit string budget of %i characters', limit => {
    expect(snipString('a'.repeat(5000), limit).length).toBeLessThanOrEqual(limit)
  })

  it('rejects an invalid protected message range', () => {
    expect(() => snipCompact([{ role: 'user', content: 'hello' }], -1)).toThrow()
  })
})
