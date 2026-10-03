/**
 * Goal System — autonomous goal pursuit with state machine
 *
 * Lets the LLM define and pursue long-horizon goals by breaking them
 * into subtasks, tracking progress, and iterating until complete.
 *
 * States:
 *   pending → in_progress → completed | failed | paused
 *
 * A goal has:
 *   - objective: the high-level description
 *   - subtasks: atomic steps to achieve the goal
 *   - context: accumulated learnings
 *   - attempts: iteration count
 */

import { existsSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { isRecord, isStringArray, readPersistedRows } from './persistedData.js'

// ── Types ───────────────────────────────────────────────────────────────────

export type GoalStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'paused'

export interface SubTask {
  id: string
  description: string
  status: 'pending' | 'in_progress' | 'done' | 'skipped' | 'failed'
  result?: string
  attempts: number
}

export interface Goal {
  id: string
  objective: string
  status: GoalStatus
  subtasks: SubTask[]
  context: string[]
  attempts: number
  maxAttempts: number
  createdAt: string
  updatedAt: string
  completedAt?: string
  priority: 'low' | 'medium' | 'high' | 'critical'
  tags: string[]
}

export interface GoalStore {
  goals: Goal[]
}

// ── Store ───────────────────────────────────────────────────────────────────

const goals = new Map<string, Goal>()
let initialized = false
let loadedPath: string | undefined

function getStorePath(): string {
  const override = process.env.OVOLV999_TEST_STORE_DIR
  if (override) return join(override, 'goals.json')
  return join(homedir(), '.ovolv999', 'goals.json')
}

function loadStore(): void {
  const path = getStorePath()
  if (initialized && loadedPath === path) return
  goals.clear()
  loadedPath = path
  initialized = true
  if (!existsSync(path)) return
  try {
    for (const g of readPersistedRows(path, 'goals', isGoal)) {
      goals.set(g.id, g)
    }
  } catch { /* corrupt store */ }
}

function isGoal(value: unknown): value is Goal {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' && typeof value.objective === 'string'
    && typeof value.status === 'string' && ['pending', 'in_progress', 'completed', 'failed', 'paused'].includes(value.status)
    && Array.isArray(value.subtasks) && value.subtasks.every(task => isRecord(task)
      && typeof task.id === 'string' && typeof task.description === 'string'
      && typeof task.status === 'string' && ['pending', 'in_progress', 'done', 'skipped', 'failed'].includes(task.status)
      && Number.isSafeInteger(task.attempts) && Number(task.attempts) >= 0)
    && isStringArray(value.context) && isStringArray(value.tags)
    && Number.isSafeInteger(value.attempts) && Number(value.attempts) >= 0
    && Number.isSafeInteger(value.maxAttempts) && Number(value.maxAttempts) > 0
    && typeof value.priority === 'string' && ['low', 'medium', 'high', 'critical'].includes(value.priority)
    && typeof value.createdAt === 'string' && typeof value.updatedAt === 'string'
    && (value.completedAt === undefined || typeof value.completedAt === 'string')
}

function saveStore(): void {
  const path = getStorePath()
  const dir = join(path, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const store: GoalStore = { goals: Array.from(goals.values()) }
  writeFileSync(path, JSON.stringify(store, null, 2))
}

export function resetGoalStore(): void {
  goals.clear()
  initialized = false
  loadedPath = undefined
  // In test mode, also clear the store file so tests start fresh
  if (process.env.OVOLV999_TEST_STORE_DIR) {
    try {
      const path = getStorePath()
      if (existsSync(path)) {
        writeFileSync(path, JSON.stringify({ goals: [] }, null, 2))
      }
    } catch { /* ignore */ }
  }
}

// ── CRUD ────────────────────────────────────────────────────────────────────

export function createGoal(
  objective: string,
  options: {
    subtasks?: string[]
    priority?: Goal['priority']
    maxAttempts?: number
    tags?: string[]
  } = {},
): Goal {
  loadStore()
  const id = `goal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const now = new Date().toISOString()

  const goal: Goal = {
    id,
    objective,
    status: 'pending',
    subtasks: (options.subtasks ?? []).map((desc, i) => ({
      id: `${id}-sub-${i + 1}`,
      description: desc,
      status: 'pending' as const,
      attempts: 0,
    })),
    context: [],
    attempts: 0,
    maxAttempts: options.maxAttempts ?? 5,
    createdAt: now,
    updatedAt: now,
    priority: options.priority ?? 'medium',
    tags: options.tags ?? [],
  }

  if (!isGoal(goal)) throw new Error('Invalid goal configuration')
  goals.set(id, goal)
  saveStore()
  return goal
}

export function getGoal(id: string): Goal | undefined {
  loadStore()
  return goals.get(id)
}

export function listGoals(filter?: {
  status?: GoalStatus
  priority?: Goal['priority']
  tag?: string
}): Goal[] {
  loadStore()
  let result = Array.from(goals.values())
  if (filter?.status) result = result.filter(g => g.status === filter.status)
  if (filter?.priority) result = result.filter(g => g.priority === filter.priority)
  if (filter?.tag) result = result.filter(g => g.tags.includes(filter.tag!))
  return result.sort((a, b) => {
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 }
    return priorityOrder[a.priority] - priorityOrder[b.priority]
  })
}

export function updateGoal(id: string, updates: Partial<Goal>): Goal | undefined {
  loadStore()
  const goal = goals.get(id)
  if (!goal) return undefined
  const provided = Object.fromEntries(Object.entries(updates).filter(([, value]) => value !== undefined))
  const updated = { ...goal, ...provided, id: goal.id, createdAt: goal.createdAt, updatedAt: new Date().toISOString() }
  if (!isGoal(updated)) return undefined
  Object.assign(goal, updated)
  goals.set(id, goal)
  saveStore()
  return goal
}

export function deleteGoal(id: string): boolean {
  loadStore()
  const existed = goals.delete(id)
  if (existed) saveStore()
  return existed
}

// ── Subtask Operations ──────────────────────────────────────────────────────

export function addSubtask(goalId: string, description: string): SubTask | undefined {
  const goal = getGoal(goalId)
  if (!goal) return undefined
  const subtask: SubTask = {
    id: `${goalId}-sub-${goal.subtasks.length + 1}`,
    description,
    status: 'pending',
    attempts: 0,
  }
  goal.subtasks.push(subtask)
  goal.updatedAt = new Date().toISOString()
  goals.set(goalId, goal)
  saveStore()
  return subtask
}

export function updateSubtask(
  goalId: string,
  subtaskId: string,
  updates: Partial<SubTask>,
): SubTask | undefined {
  const goal = getGoal(goalId)
  if (!goal) return undefined
  const subtask = goal.subtasks.find(s => s.id === subtaskId)
  if (!subtask) return undefined
  const enteringAttempt = updates.status === 'in_progress' && subtask.status !== 'in_progress'
  const provided = Object.fromEntries(Object.entries(updates).filter(([, value]) => value !== undefined))
  const updated = { ...subtask, ...provided, id: subtask.id }
  if (!isGoal({ ...goal, subtasks: goal.subtasks.map(task => task === subtask ? updated : task) })) return undefined
  Object.assign(subtask, updated)
  if (enteringAttempt && updates.attempts === undefined) subtask.attempts++
  goal.updatedAt = new Date().toISOString()
  goals.set(goalId, goal)
  saveStore()
  return subtask
}

export function getNextSubtask(goalId: string): SubTask | undefined {
  const goal = getGoal(goalId)
  if (!goal) return undefined
  return goal.subtasks.find(s => s.status === 'pending' || s.status === 'in_progress')
}

// ── State Transitions ───────────────────────────────────────────────────────

export function startGoal(id: string): Goal | undefined {
  return updateGoal(id, { status: 'in_progress' })
}

export function completeGoal(id: string): Goal | undefined {
  return updateGoal(id, {
    status: 'completed',
    completedAt: new Date().toISOString(),
  })
}

export function failGoal(id: string, reason?: string): Goal | undefined {
  const goal = getGoal(id)
  if (!goal) return undefined
  if (reason) goal.context.push(`Failure reason: ${reason}`)
  return updateGoal(id, { status: 'failed', completedAt: new Date().toISOString() })
}

export function pauseGoal(id: string): Goal | undefined {
  return updateGoal(id, { status: 'paused' })
}

export function resumeGoal(id: string): Goal | undefined {
  return updateGoal(id, { status: 'in_progress' })
}

export function retryGoal(id: string): Goal | undefined {
  const goal = getGoal(id)
  if (!goal) return undefined
  if (goal.attempts >= goal.maxAttempts) return undefined
  goal.attempts++
  // Reset failed subtasks to pending
  for (const s of goal.subtasks) {
    if (s.status === 'failed') s.status = 'pending'
  }
  return updateGoal(id, { status: 'in_progress' })
}

// ── Context Management ──────────────────────────────────────────────────────

export function addContext(id: string, note: string): Goal | undefined {
  const goal = getGoal(id)
  if (!goal) return undefined
  goal.context.push(`[${new Date().toISOString()}] ${note}`)
  goal.updatedAt = new Date().toISOString()
  goals.set(id, goal)
  saveStore()
  return goal
}

// ── Progress ────────────────────────────────────────────────────────────────

export interface GoalProgress {
  total: number
  done: number
  pending: number
  inProgress: number
  failed: number
  skipped: number
  percentage: number
}

export function getProgress(goalId: string): GoalProgress | undefined {
  const goal = getGoal(goalId)
  if (!goal) return undefined
  const total = goal.subtasks.length
  const done = goal.subtasks.filter(s => s.status === 'done').length
  const pending = goal.subtasks.filter(s => s.status === 'pending').length
  const inProgress = goal.subtasks.filter(s => s.status === 'in_progress').length
  const failed = goal.subtasks.filter(s => s.status === 'failed').length
  const skipped = goal.subtasks.filter(s => s.status === 'skipped').length

  return {
    total,
    done,
    pending,
    inProgress,
    failed,
    skipped,
    percentage: total === 0 ? 0 : Math.round((done / total) * 100),
  }
}

// ── Formatting ──────────────────────────────────────────────────────────────

const STATUS_ICONS: Record<GoalStatus, string> = {
  pending: '○',
  in_progress: '◐',
  completed: '✓',
  failed: '✗',
  paused: '⏸',
}

export function formatGoal(goal: Goal): string {
  const progress = getProgress(goal.id)
  const icon = STATUS_ICONS[goal.status]
  const lines: string[] = [
    `${icon} Goal: ${goal.objective}`,
    `  ID: ${goal.id}`,
    `  Status: ${goal.status} | Priority: ${goal.priority}`,
  ]

  if (progress && progress.total > 0) {
    const bar = progressBar(progress.percentage)
    lines.push(`  Progress: ${bar} ${progress.done}/${progress.total} (${progress.percentage}%)`)
  }

  lines.push(`  Attempts: ${goal.attempts}/${goal.maxAttempts}`)
  if (goal.tags.length > 0) lines.push(`  Tags: ${goal.tags.join(', ')}`)

  if (goal.subtasks.length > 0) {
    lines.push(`  Subtasks:`)
    for (const s of goal.subtasks) {
      const sIcon = { pending: '○', in_progress: '◐', done: '✓', failed: '✗', skipped: '⊘' }[s.status]
      lines.push(`    ${sIcon} ${s.description}`)
    }
  }

  if (goal.context.length > 0) {
    lines.push(`  Context (${goal.context.length}):`)
    for (const c of goal.context.slice(-3)) {
      lines.push(`    ${c.slice(0, 100)}`)
    }
  }

  return lines.join('\n')
}

export function formatGoalList(goals: Goal[]): string {
  if (goals.length === 0) return 'No goals found.'
  const lines: string[] = [`Goals (${goals.length}):`]
  for (const g of goals) {
    const progress = getProgress(g.id)
    const icon = STATUS_ICONS[g.status]
    const progressStr = progress && progress.total > 0 ? ` [${progress.done}/${progress.total}]` : ''
    lines.push(`  ${icon} ${g.objective.slice(0, 60)}${progressStr} (${g.priority})`)
  }
  return lines.join('\n')
}

function progressBar(percentage: number, width = 20): string {
  const filled = Math.round((percentage / 100) * width)
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}]`
}
