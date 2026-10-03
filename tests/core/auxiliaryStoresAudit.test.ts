import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createGoal, updateGoal, updateSubtask, resetGoalStore, listGoals } from '../../src/core/goals.js'
import { loadTimers, startTimer, getTimerStats, stopTimer } from '../../src/core/taskTimer.js'
import { loadUsageStats, getUsageStatsPath } from '../../src/core/skillSearch.js'
import { recordToolCall, getAggregates, getEvents, setEnabled, clearData } from '../../src/core/telemetry.js'
import { analyzeSession } from '../../src/core/sessionStats.js'
import { getTranscriptStats, buildTranscript } from '../../src/core/sessionTranscript.js'
import { getRawConfig, migrateConfig, saveRawConfig } from '../../src/core/migrations.js'

let cwd: string
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'ovogo-auxiliary-audit-'))
  vi.stubEnv('HOME', cwd); vi.stubEnv('USERPROFILE', cwd)
  resetGoalStore()
})
afterEach(() => {
  resetGoalStore()
  clearData()
  vi.unstubAllEnvs()
  rmSync(cwd, { recursive: true, force: true })
})

describe('auxiliary persisted state audit', () => {
  it('does not erase goal or subtask fields when optional updates are undefined', () => {
    const goal = createGoal('task', { subtasks: ['step'] })
    expect(updateGoal(goal.id, { objective: undefined, priority: 'high' })?.objective).toBe('task')
    expect(updateSubtask(goal.id, goal.subtasks[0].id, { description: undefined, result: 'progress' })?.description).toBe('step')
  })

  it('isolates goal caches when the storage home changes', () => {
    createGoal('first home')
    vi.stubEnv('HOME', join(cwd, 'another'))
    vi.stubEnv('USERPROFILE', join(cwd, 'another'))
    expect(listGoals()).toEqual([])
  })

  it('rejects invalid goals before writing them', () => {
    expect(() => createGoal('task', { maxAttempts: -1 })).toThrow()
    expect(listGoals()).toEqual([])
  })

  it('counts subtask attempts when entering in_progress rather than comparing overwritten state', () => {
    const goal = createGoal('task', { subtasks: ['step'] })
    expect(updateSubtask(goal.id, goal.subtasks[0].id, { status: 'in_progress' })?.attempts).toBe(1)
  })

  it('skips malformed goal records and still lists healthy goals', () => {
    const goal = createGoal('healthy')
    resetGoalStore()
    writeFileSync(join(cwd, '.ovolv999', 'goals.json'), JSON.stringify({ goals: [goal, { id: 'broken' }] }))
    expect(listGoals()).toEqual([goal])
  })

  it('recovers invalid timer JSON and treats prototype categories as ordinary names', () => {
    mkdirSync(join(cwd, '.ovolv999'), { recursive: true })
    writeFileSync(join(cwd, '.ovolv999', 'timers.json'), 'null')
    expect(loadTimers(cwd).timers).toEqual([])
    const timer = startTimer(cwd, 'timer', { category: 'constructor', tags: ['__proto__'] })
    expect(stopTimer(cwd, '')).toBeNull()
    stopTimer(cwd, timer.id)
    const stats = getTimerStats(cwd)
    expect(typeof stats.totalTimeByCategory.constructor).toBe('number')
    expect(typeof stats.totalTimeByTag['__proto__']).toBe('number')
  })

  it('preserves valid skill usage when a single malformed row is present', () => {
    mkdirSync(join(cwd, '.ovolv999'), { recursive: true })
    const healthy = { skillName: 'a', useCount: 1, lastUsed: '2026-10-03', successRate: 1 }
    writeFileSync(getUsageStatsPath(), JSON.stringify([healthy, null]))
    expect(loadUsageStats().get('a')).toEqual(healthy)
  })

  it('isolates telemetry storage homes and preserves valid rows in damaged arrays', () => {
    clearData()
    const home = join(cwd, 'other')
    vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home)
    mkdirSync(join(home, '.ovolv999'), { recursive: true })
    const healthy = { type: 'tool_call', tool: 'Read', timestamp: '2026-10-03' }
    writeFileSync(join(home, '.ovolv999', 'telemetry.json'), JSON.stringify([null, healthy]))
    expect(getEvents()).toEqual([healthy])
    setEnabled(true)
    recordToolCall('constructor', 0)
    expect(getAggregates().toolCallCounts.constructor).toBe(1)
  })

  it('counts prototype tool names in session and transcript summaries', () => {
    const result = analyzeSession([{ role: 'assistant', content: '', tool_calls: [
      { id: '1', type: 'function', function: { name: 'constructor', arguments: '{}' } },
    ] }])
    expect(result.toolCallsByName.constructor).toBe(1)
    const transcript = buildTranscript({ sessionId: 'a', startTime: '2026-10-03' }, [
      { role: 'assistant', content: '', timestamp: '', toolCalls: [{ name: '__proto__', input: {} }] },
    ])
    expect(getTranscriptStats(transcript).toolNames['__proto__']).toBe(1)
  })

  it('migrates provider model without replacing the typed model preferences with a string', () => {
    saveRawConfig({ version: 0, model: 'legacy-model' }, 'project', cwd)
    const migrated = migrateConfig('project', cwd)
    expect(migrated.config.provider.name).toBe('openai')
    expect(migrated.config.provider.model).toBe('legacy-model')
    expect(migrated.config.model.temperature).toBe(0.7)
    expect(getRawConfig('project', cwd)?.version).toBe(2)
  })
})
