import type { Command } from './index.js'
import { text } from './results.js'
import { ClaudeCodeWorkerManager } from '../core/claudeCodeWorkerManager.js'

let workerManager: ClaudeCodeWorkerManager = new ClaudeCodeWorkerManager()

export function setWorkerManager(manager: ClaudeCodeWorkerManager): void {
  workerManager = manager
}

export function resetWorkerManager(): void {
  workerManager = new ClaudeCodeWorkerManager()
}

export const automationCommands: Command[] = [
  {
    name: 'tasks',
    description: 'List background tasks',
    aliases: ['t'],
    handler: (_args, ctx) => {
      const mgr = ctx.engine.getBackgroundTaskManager()
      const tasks = mgr.listTasks()
      if (tasks.length === 0) {
        return text('No background tasks.')
      }
      const lines = tasks.map((t) => {
        const icon =
          t.status === 'running'
            ? '\u25C6'
            : t.status === 'completed'
              ? '\u2713'
              : t.status === 'failed'
                ? '\u2717'
                : '\u2299'
        const dur = t.durationMs !== null ? ' (' + (t.durationMs / 1000).toFixed(1) + 's)' : ''
        return '  ' + icon + ' ' + t.id + ' [' + t.status + ']' + dur + ' ' + t.description
      })
      return text('Background tasks (' + tasks.length + '):\n' + lines.join('\n'))
    },
  },
  {
    name: 'workers',
    description: 'Manage external Claude Code tmux workers',
    usage: '/workers [list|start [session]|capture [session] [lines]|stop <session>]',
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean)
      const action = parts[0] ?? 'list'
      const session = parts[1] ?? 'ovogo-claude-worker'
      const mgr = workerManager
      try {
        if (action === 'list') {
          const sessions = await mgr.list()
          const workers = sessions.filter((s) => s.startsWith('ovogo-'))
          if (workers.length === 0) return text('No ovogo worker sessions.')
          return text('Worker sessions:\n' + workers.map((s) => '  ' + s).join('\n'))
        }
        if (action === 'start') {
          const result = await mgr.start({ session, cwd: ctx.cwd })
          return text(
            [
              `Worker: ${result.session}`,
              result.created ? 'Status: started' : 'Status: already running',
              `Synced env: ${result.syncedEnv.length ? result.syncedEnv.join(', ') : 'none'}`,
            ].join('\n'),
          )
        }
        if (action === 'capture') {
          const rawLines = parts[2]
          const lines = rawLines === undefined ? 80 : Number(rawLines)
          const safeLines = Number.isFinite(lines) ? Math.max(0, Math.floor(lines)) : 80
          if (!(await mgr.sessionExists(session))) {
            return text(
              `Worker session not found: ${session}. Use /workers list to see active workers.`,
            )
          }
          const output = await mgr.capture(session, safeLines)
          return text(output || '(no output)')
        }
        if (action === 'stop') {
          if (!parts[1]) return text('Usage: /workers stop <session>')
          const result = await mgr.stop(session)
          return text(
            result.stopped ? `Stopped worker: ${session}` : `Worker not running: ${session}`,
          )
        }
        return text(
          'Usage: /workers [list|start [session]|capture [session] [lines]|stop <session>]',
        )
      } catch (err) {
        return text(`Workers command failed: ${(err as Error).message}`)
      }
    },
  },
  {
    name: 'workflow',
    aliases: ['wf'],
    description: 'Run or list workflows. Usage: /workflow [list|run <name>|init <name>]',
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/)
      const subcommand = parts[0] ?? 'list'
      const { loadWorkflows, loadWorkflow, executeWorkflow, writeSampleWorkflow } =
        await import('../core/workflow.js')
      if (subcommand === 'list' || subcommand === '' || !subcommand) {
        const workflows = loadWorkflows(ctx.cwd)
        if (workflows.size === 0) {
          return text(
            'No workflows found. Create one with: /workflow init <name>\nLocation: .ovolv999/workflows/*.json',
          )
        }
        const lines: string[] = [`Workflows (${workflows.size}):`]
        for (const [name, wf] of workflows) {
          const desc = wf.description ? ` — ${wf.description}` : ''
          const stepCount = wf.steps.length
          lines.push(`  ${name.padEnd(20)} ${stepCount} step(s)${desc}`)
        }
        return text(lines.join('\n'))
      }
      if (subcommand === 'init' || subcommand === 'create') {
        const name = parts[1]
        if (!name) return text('Usage: /workflow init <name>')
        const path = writeSampleWorkflow(ctx.cwd, name)
        return text(
          `✓ Created sample workflow: ${path}\nEdit it to define your steps, then run with: /workflow run ${name}`,
        )
      }
      if (subcommand === 'run') {
        const name = parts[1]
        if (!name) return text('Usage: /workflow run <name>')
        const wf = loadWorkflow(ctx.cwd, name)
        if (!wf) {
          const available = loadWorkflows(ctx.cwd)
          const names = [...available.keys()]
          return text(
            `Workflow "${name}" not found.${names.length ? `\nAvailable: ${names.join(', ')}` : ''}`,
          )
        }
        const result = await executeWorkflow(wf, {
          cwd: ctx.cwd,
          runSlash: async (cmd: string) => {
            const dispatch = (
              ctx as unknown as {
                dispatchSlash?: (s: string) => Promise<boolean>
              }
            ).dispatchSlash
            if (typeof dispatch === 'function') {
              await dispatch(cmd)
              return `(executed: ${cmd})`
            }
            return `(slash not available: ${cmd})`
          },
        })
        const lines: string[] = [
          `Workflow "${result.workflowName}" ${result.success ? '✓ completed' : '✗ failed'} (${result.durationMs}ms)`,
          '',
        ]
        for (const step of result.steps) {
          const status = step.success ? '✓' : '✗'
          const out = step.output
            ? ` → ${step.output.slice(0, 80)}${step.output.length > 80 ? '...' : ''}`
            : ''
          const err = step.error ? ` [${step.error.slice(0, 80)}]` : ''
          lines.push(`  ${status} ${step.name} (${step.durationMs}ms)${out}${err}`)
        }
        return text(lines.join('\n'))
      }
      const wf = loadWorkflow(ctx.cwd, subcommand)
      if (wf) {
        const result = await executeWorkflow(wf, { cwd: ctx.cwd })
        return text(
          `Workflow "${result.workflowName}" ${result.success ? '✓' : '✗'} — ${result.steps.length} steps in ${result.durationMs}ms`,
        )
      }
      return text(
        `Unknown subcommand: ${subcommand}\nUsage: /workflow [list|run <name>|init <name>]`,
      )
    },
  },
  {
    name: 'notify',
    description: 'Test desktop notification. Usage: /notify [title] [body]',
    handler: async (args) => {
      const { notify } = await import('../utils/notifier.js')
      const parts = args.trim().split(/\s+/)
      const title = parts[0] ?? 'ovolv999'
      const body = parts.slice(1).join(' ') || 'Notification test'
      const result = notify({ title, body, sound: true })
      if (result.success) {
        return text(`✓ Notification sent via ${result.channel}`)
      }
      return text(`⚠ Notification failed: ${result.error ?? 'unknown error'}`)
    },
  },
  {
    name: 'schedule',
    aliases: ['cron'],
    description:
      'Manage scheduled tasks. Usage: /schedule [list|create <cron> <prompt>|remove <id>|enable <id>|disable <id>]',
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/)
      const subcommand = parts[0] ?? 'list'
      const {
        loadSchedules,
        addTask,
        removeTask,
        enableTask,
        disableTask,
        createTask,
        formatTaskList,
        parseCron,
        parseEveryDuration,
      } = await import('../core/cron.js')
      if (subcommand === 'list' || !subcommand) {
        const store = loadSchedules(ctx.cwd)
        return text(formatTaskList(store.tasks))
      }
      if (subcommand === 'create' || subcommand === 'add') {
        const remaining = args.trim().slice(parts[0].length).trim()
        const cronMatch = remaining.match(/^(@\w+|"[^"]+"|\S+)\s+(.*)$/)
        if (!cronMatch) {
          return text(
            'Usage: /schedule create <cron> <prompt>\nExample: /schedule create "0 9 * * 1-5" "run tests"',
          )
        }
        const cronExpr = cronMatch[1].replace(/^"(.*)"$/, '$1')
        const prompt = cronMatch[2].replace(/^["'](.*)["']$/, '$1')
        try {
          if (cronExpr.startsWith('@every')) {
            parseEveryDuration(cronExpr)
          } else {
            parseCron(cronExpr)
          }
        } catch (err) {
          return text(`Invalid cron expression: ${(err as Error).message}`)
        }
        const name = `task_${Date.now().toString(36)}`
        const task = createTask(name, cronExpr, prompt)
        addTask(ctx.cwd, task)
        return text(
          `✓ Scheduled task created: ${name}\n  Cron: ${cronExpr}\n  Prompt: "${prompt}"\n  Next: ${task.nextRun ?? 'N/A'}`,
        )
      }
      if (subcommand === 'remove' || subcommand === 'delete' || subcommand === 'rm') {
        const id = parts[1]
        if (!id) return text('Usage: /schedule remove <id or name>')
        const success = removeTask(ctx.cwd, id)
        return text(success ? `✓ Removed task: ${id}` : `⚠ Task not found: ${id}`)
      }
      if (subcommand === 'enable') {
        const id = parts[1]
        if (!id) return text('Usage: /schedule enable <id or name>')
        const success = enableTask(ctx.cwd, id)
        return text(success ? `✓ Enabled task: ${id}` : `⚠ Task not found: ${id}`)
      }
      if (subcommand === 'disable') {
        const id = parts[1]
        if (!id) return text('Usage: /schedule disable <id or name>')
        const success = disableTask(ctx.cwd, id)
        return text(success ? `✓ Disabled task: ${id}` : `⚠ Task not found: ${id}`)
      }
      return text(
        `Unknown subcommand: ${subcommand}\nUsage: /schedule [list|create|remove|enable|disable]`,
      )
    },
  },
  {
    name: 'timer',
    aliases: ['timers', 'tm'],
    description:
      'Track task time. Usage: /timer [start <name> | stop <id> | pause <id> | resume <id> | list | stats | remove <id>]',
    handler: async (args, ctx) => {
      const {
        startTimer,
        stopTimer,
        pauseTimer,
        resumeTimer,
        removeTimer,
        getAllTimers,
        getRunningTimers,
        getTimerStats,
        formatTimer,
        formatTimerList,
        formatTimerStats,
      } = await import('../core/taskTimer.js')
      const parts = args.trim().split(/\s+/)
      const sub = parts[0] ?? 'list'
      if (sub === 'start') {
        const name = parts.slice(1).join(' ')
        if (!name) return text('Usage: /timer start <task name>')
        const t = startTimer(ctx.cwd, name)
        return text(`✓ Timer started: "${name}" (id: ${t.id})`)
      }
      if (sub === 'stop' || sub === 'done') {
        const target = parts.slice(1).join(' ')
        if (!target) return text('Usage: /timer stop <id|name>')
        const t = stopTimer(ctx.cwd, target)
        if (!t) return text('No running timer found matching that id/name')
        return text(formatTimer(t))
      }
      if (sub === 'pause') {
        const target = parts.slice(1).join(' ')
        if (!target) return text('Usage: /timer pause <id|name>')
        const t = pauseTimer(ctx.cwd, target)
        if (!t) return text('No running timer found matching that id/name')
        return text(`⏸ Paused: "${t.name}"`)
      }
      if (sub === 'resume') {
        const target = parts.slice(1).join(' ')
        if (!target) return text('Usage: /timer resume <id|name>')
        const t = resumeTimer(ctx.cwd, target)
        if (!t) return text('No paused timer found matching that id/name')
        return text(`▶ Resumed: "${t.name}"`)
      }
      if (sub === 'remove' || sub === 'rm') {
        const target = parts.slice(1).join(' ')
        if (!target) return text('Usage: /timer remove <id|name>')
        return text(removeTimer(ctx.cwd, target) ? '✓ Timer removed' : 'Timer not found')
      }
      if (sub === 'stats') {
        const stats = getTimerStats(ctx.cwd)
        return text(formatTimerStats(stats))
      }
      if (sub === 'running') {
        const timers = getRunningTimers(ctx.cwd)
        return text(formatTimerList(timers))
      }
      if (sub === 'list' || !sub) {
        const timers = getAllTimers(ctx.cwd)
        return text(formatTimerList(timers))
      }
      return text(`Usage: /timer [start|stop|pause|resume|list|running|stats|remove]`)
    },
  },
  {
    name: 'goal',
    aliases: ['goals'],
    description:
      'Manage autonomous goals. Usage: /goal [list | create <objective> | show <id> | complete <id> | fail <id> <reason>]',
    handler: async (args, _ctx) => {
      const {
        createGoal,
        getGoal,
        listGoals,
        startGoal,
        completeGoal,
        failGoal,
        pauseGoal,
        resumeGoal,
        addSubtask,
        updateSubtask,
        getProgress,
        formatGoal,
        formatGoalList,
        deleteGoal,
      } = await import('../core/goals.js')
      const parts = args.trim().split(/\s+/)
      const sub = parts[0] ?? 'list'
      if (sub === 'list' || sub === 'ls') {
        return text(formatGoalList(listGoals()))
      }
      if (sub === 'create') {
        const objective = parts.slice(1).join(' ')
        if (!objective) return text('Usage: /goal create <objective>')
        const goal = createGoal(objective)
        return text(formatGoal(goal))
      }
      if (sub === 'show' || sub === 'get') {
        const id = parts[1]
        if (!id) return text('Usage: /goal show <id>')
        const goal = getGoal(id)
        if (!goal) return text('Goal not found')
        return text(formatGoal(goal))
      }
      if (sub === 'start') {
        const id = parts[1]
        const goal = startGoal(id)
        return text(goal ? formatGoal(goal) : 'Goal not found')
      }
      if (sub === 'complete') {
        const id = parts[1]
        const goal = completeGoal(id)
        return text(goal ? `Completed: ${goal.objective}` : 'Goal not found')
      }
      if (sub === 'fail') {
        const id = parts[1]
        const reason = parts.slice(2).join(' ')
        const goal = failGoal(id, reason)
        return text(goal ? `Failed: ${goal.objective}` : 'Goal not found')
      }
      if (sub === 'pause') {
        const id = parts[1]
        const goal = pauseGoal(id)
        return text(goal ? `Paused: ${goal.objective}` : 'Goal not found')
      }
      if (sub === 'resume') {
        const id = parts[1]
        const goal = resumeGoal(id)
        return text(goal ? `Resumed: ${goal.objective}` : 'Goal not found')
      }
      if (sub === 'add-subtask') {
        const id = parts[1]
        const desc = parts.slice(2).join(' ')
        const st = addSubtask(id, desc)
        return text(st ? `Added: ${st.description}` : 'Goal not found')
      }
      if (sub === 'done') {
        const goalId = parts[1]
        const subtaskId = parts[2]
        const st = updateSubtask(goalId, subtaskId, { status: 'done' })
        return text(st ? `Done: ${st.description}` : 'Not found')
      }
      if (sub === 'delete') {
        const id = parts[1]
        return text(deleteGoal(id) ? `Deleted: ${id}` : 'Goal not found')
      }
      if (sub === 'progress') {
        const id = parts[1]
        const p = getProgress(id)
        if (!p) return text('Goal not found')
        return text(
          `Progress: ${p.done}/${p.total} (${p.percentage}%) - ${p.pending} pending, ${p.inProgress} in progress, ${p.failed} failed`,
        )
      }
      return text(
        `Usage: /goal [list | create <objective> | show <id> | start <id> | complete <id> | fail <id> <reason> | pause <id> | resume <id> | add-subtask <id> <desc> | done <goalId> <subId> | progress <id> | delete <id>]`,
      )
    },
  },
  {
    name: 'daemon',
    description: 'Manage daemon mode. Usage: /daemon [status | start | stop | workers]',
    handler: async () => {
      const daemonModule = await import('../core/daemon.js')
      const { isDaemonRunning, getDaemonSocketPath } = daemonModule
      return text(
        'Daemon control requires running ovolv999 --daemon. Socket: ' +
          getDaemonSocketPath() +
          '\nRunning: ' +
          (await isDaemonRunning()),
      )
    },
  },
]
