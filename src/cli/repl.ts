import { dispatchSlashCommand, listCommands, type SlashCommandContext } from '../commands/index.js'
import { getProjectSettingsPath, saveProjectSettings } from '../config/settings.js'
import { ExecutionEngine } from '../core/engine.js'
import type { EpisodicMemory } from '../core/episodicMemory.js'
import { normalizeOutcome, settleWithin } from '../core/outcome.js'
import type { SemanticMemory } from '../core/semanticMemory.js'
import {
  AmbiguousSessionError,
  SessionNotFoundError,
  claimSessionOwnership,
  listSessions,
  loadSession,
  releaseSessionOwnership,
  resolveSessionPath,
  saveSession,
} from '../core/sessionManager.js'
import type { EngineConfig, OpenAIMessage } from '../core/types.js'
import { consolidateSession } from '../modules/reflection.js'
import type { Skill } from '../skills/loader.js'
import { createSkillRuntime, formatSkillInvocation } from '../skills/runtime.js'
import { trimHistoryForNextTurn } from '../ui/historyTrimmer.js'
import { InputHandler } from '../ui/input.js'
import type { Renderer } from '../ui/renderer.js'
import { SlashSuggester } from '../ui/slashSuggest.js'
import { runWithDeadline } from '../ui/turnDeadline.js'
import { updateProgressLog } from './progress.js'
import type { CliSessionState } from './sessionState.js'
import { HARD_TURN_DEADLINE_MS } from './tasks.js'
export async function runPlanMode(
  task: string,
  engine: ExecutionEngine,
  planConfig: EngineConfig,
  renderer: Renderer,
  input: InputHandler,
  history: OpenAIMessage[],
  cwd: string,
): Promise<void> {
  renderer.planModeStart()
  renderer.humanPrompt(`[PLAN] ${task}`)
  updateProgressLog(cwd, 'planning', task.slice(0, 100))
  const planEngine = new ExecutionEngine(planConfig, renderer)
  try {
    const { result } = await planEngine.runTurn(task, [...history])
    const status = normalizeOutcome(result)
    if (status !== 'completed') {
      renderer.warn(`Planning ${status}: ${result.reason}`)
      updateProgressLog(cwd, 'idle', 'waiting for next task')
      return
    }
  } catch (err: unknown) {
    renderer.error(`Plan error: ${(err as Error).message}`)
    updateProgressLog(cwd, 'idle', 'waiting for next task')
    return
  } finally {
    await planEngine.dispose()
  }
  renderer.planConfirmPrompt()
  const { text: answer, eof } = await input.readLine('')
  if (eof) {
    updateProgressLog(cwd, 'idle', 'waiting for next task')
    return
  }
  const confirmed = answer.trim().toLowerCase()
  if (confirmed === 'y' || confirmed === 'yes') {
    renderer.info('Executing plan...')
    renderer.humanPrompt(task)
    updateProgressLog(cwd, 'running', task.slice(0, 100))
    const startMs = Date.now()
    try {
      const { result, newHistory } = await engine.runTurn(task, history)
      history.length = 0
      history.push(...trimHistoryForNextTurn(newHistory))
      const elapsed = ((Date.now() - startMs) / 1000).toFixed(1)
      renderer.info(`${normalizeOutcome(result)} in ${elapsed}s · ${result.reason}`)
    } catch (err: unknown) {
      renderer.error(`Execution error: ${(err as Error).message}`)
    }
    updateProgressLog(cwd, 'idle', 'waiting for next task')
  } else {
    renderer.info('Plan cancelled.')
    updateProgressLog(cwd, 'idle', 'waiting for next task')
  }
}
export async function runRepl(
  sessionState: CliSessionState,
  engine: ExecutionEngine,
  planConfig: EngineConfig,
  renderer: Renderer,
  cwd: string,
  skills: Map<string, Skill>,
  hookRunner: {
    runUserPromptSubmit: (p: string) => unknown
  },
  consolidate?: {
    config: EngineConfig
    semanticMemory: SemanticMemory
    episodicMemory: EpisodicMemory
  },
  sessionDir?: string,
  resumedHistory?: OpenAIMessage[],
  signal?: AbortSignal,
): Promise<void> {
  const skillRuntime = createSkillRuntime(skills)
  const history: OpenAIMessage[] = resumedHistory ? [...resumedHistory] : []
  let getLineFn: () => string = () => ''
  const slashSuggester = new SlashSuggester({
    source: {
      isTTY: Boolean(process.stdout.isTTY),
      getCommands: () => listCommands().map((c) => ({ name: c.name, description: c.description })),
      getSkills: () =>
        [...skills.values()].map((s) => ({ name: s.name, description: s.description })),
    },
    stream: process.stdout,
    getLine: () => getLineFn(),
  })
  const input = new InputHandler({ completer: slashSuggester.complete })
  sessionState.prompt = input.sharedPrompt()
  getLineFn = () => input.getLine()
  let currentSessionDir = sessionDir
  const saveCurrentSession = (
    failureMessage: string | null = 'Failed to persist session',
  ): void => {
    if (!currentSessionDir) return
    try {
      saveSession(currentSessionDir, history)
    } catch (err: unknown) {
      if (failureMessage) renderer.warn(`${failureMessage}: ${(err as Error).message}`)
    }
  }
  sessionState.saveOnExit = () => saveCurrentSession()
  const loadSessionByRef = (ref: string): OpenAIMessage[] | null => {
    try {
      const dir = resolveSessionPath(cwd, ref)
      claimSessionOwnership(dir)
      const msgs = loadSession(dir)
      if (currentSessionDir && currentSessionDir !== dir) releaseSessionOwnership(currentSessionDir)
      currentSessionDir = dir
      return msgs
    } catch (err: unknown) {
      if (err instanceof SessionNotFoundError || err instanceof AmbiguousSessionError) {
        return null
      }
      renderer.warn(`Failed to resume session: ${(err as Error).message}`)
      return null
    }
  }
  const getSkillsText = (): string => {
    if (skills.size === 0) return 'No skills available.'
    const bySource = new Map<string, Skill[]>()
    for (const s of skills.values()) {
      const list = bySource.get(s.source) ?? []
      list.push(s)
      bySource.set(s.source, list)
    }
    const lines: string[] = []
    for (const [source, list] of bySource) {
      lines.push(`-- ${source} --`)
      for (const s of list) {
        lines.push(`/${s.name.padEnd(16)} ${s.description}`)
      }
    }
    return lines.join('\n')
  }
  const getSessionsText = (): string => {
    const sessions = listSessions(cwd)
    if (sessions.length === 0) return 'No saved sessions found.'
    const lines = [`Found ${sessions.length} session(s):`]
    for (const s of sessions.slice(0, 10)) {
      lines.push(`  ${s.name}  ${s.messages} msgs`)
    }
    if (sessions.length > 10) lines.push(`  ... and ${sessions.length - 10} more`)
    lines.push('', 'Resume with: ovolv999 --continue  or  ovolv999 --resume <session_name>')
    return lines.join('\n')
  }
  renderer.info(
    `Commands: /compact /cost /context /mode /doctor /rewind /tasks /workers /diff /commit /init /help`,
  )
  renderer.info(`ESC to interrupt · Ctrl+D to exit`)
  let running = false
  let awaitingInput = false
  let lastEscMs = 0
  const onKeypress = (
    _str: unknown,
    key: {
      name?: string
    },
  ) => {
    if (key?.name === 'escape' && running && !awaitingInput) {
      const now = Date.now()
      if (now - lastEscMs < 800) return
      lastEscMs = now
      engine.abort()
      renderer.stopSpinner()
      process.stdout.write('\n')
      renderer.warn('Interrupted. Type feedback or press Enter to resume.')
    }
  }
  process.stdin.on('keypress', onKeypress)
  let sigintCount = 0
  let lastSigintMs = 0
  const onSigint = () => {
    sigintCount++
    const now = Date.now()
    const rapid = now - lastSigintMs < 1500
    lastSigintMs = now
    if (running && !rapid) {
      engine.abort()
      renderer.stopSpinner()
      renderer.warn('Cancelled. Press Ctrl+C again within 1.5s to force exit.')
      return
    }
    renderer.newline()
    renderer.info('Force exit (Ctrl+C x' + sigintCount + '). Saving session...')
    try {
      sessionState.saveOnExit?.()
    } catch (error) {
      void error
    }
    try {
      input.close()
    } catch (error) {
      void error
    }
    process.exit(130)
  }
  process.on('SIGINT', onSigint)
  input.readline?.on('SIGINT', onSigint)
  async function submitPrompt(prompt: string): Promise<boolean> {
    try {
      await hookRunner.runUserPromptSubmit(prompt)
      return true
    } catch (error) {
      renderer.error(`Prompt submission failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }
  async function runTask(
    prompt: string,
    taskHistory: OpenAIMessage[],
    startMs: number,
  ): Promise<void> {
    running = true
    let currentPrompt = prompt
    let currentHistory = taskHistory
    try {
      while (true) {
        let result: Awaited<ReturnType<ExecutionEngine['runTurn']>>
        let deadlineExceeded = false
        const dl = runWithDeadline(() => engine.runTurn(currentPrompt, currentHistory), {
          deadlineMs: HARD_TURN_DEADLINE_MS,
          onDeadline: () => {
            deadlineExceeded = true
            engine.abort()
          },
        })
        try {
          result = await dl.promise
        } catch (err: unknown) {
          const error = err as Error
          if (error.name === 'AbortError' || deadlineExceeded) {
            renderer.warn(
              deadlineExceeded
                ? `Turn hit the ${HARD_TURN_DEADLINE_MS / 1000}s hard deadline — aborting.`
                : 'Turn aborted.',
            )
            const settled = await settleWithin(dl.taskSettled, 3000).catch((error: unknown) => {
              renderer.error((error as Error).message)
              return undefined
            })
            if (!settled) {
              await settleWithin(Promise.resolve(engine.dispose()), 3000).catch(() => {})
              process.exitCode = 2
              break
            }
            if (settled.status === 'fulfilled' && settled.value) {
              history.length = 0
              history.push(...trimHistoryForNextTurn(settled.value.newHistory))
            }
            currentHistory = [...history]
            saveCurrentSession(null)
            renderer.writeInterruptPrompt()
            awaitingInput = true
            const { text: feedback, eof } = await input.readLine('')
            awaitingInput = false
            if (eof) break
            const trimmedFeedback = feedback.trim()
            currentPrompt = trimmedFeedback
              ? `[User Interrupt]\n${trimmedFeedback}\n\n${deadlineExceeded ? 'The previous turn exceeded a safety deadline. ' : ''}Adjust your actions and continue.`
              : deadlineExceeded ? '[Resume] The previous turn hit a safety deadline. Try a simpler approach.' : '[Resume] Continue the interrupted task.'
            continue
          }
          throw err
        } finally {
          dl.clear()
        }
        history.length = 0
        history.push(...trimHistoryForNextTurn(result.newHistory))
        currentHistory = [...history]
        saveCurrentSession()
        if (result.result.reason === 'interrupted' || result.result.reason === 'error') {
          renderer.writeInterruptPrompt()
          awaitingInput = true
          const { text: feedback, eof } = await input.readLine('')
          awaitingInput = false
          if (eof) {
            saveCurrentSession(null)
            break
          }
          const trimmedFeedback = feedback.trim()
          if (trimmedFeedback) {
            renderer.interruptInjected(trimmedFeedback)
            currentPrompt = `[User Interrupt]\n${trimmedFeedback}\n\nAdjust your actions based on the above feedback and continue the task.`
          } else {
            currentPrompt =
              '[Resume] Continue the task autonomously. Do not wait for further instructions.'
          }
          continue
        }
        const elapsed = ((Date.now() - startMs) / 1000).toFixed(1)
        renderer.info(`${normalizeOutcome(result.result)} in ${elapsed}s · ${result.result.reason}`)
        break
      }
    } catch (err: unknown) {
      const error = err as Error
      if (error.name !== 'AbortError') {
        renderer.error(`Error: ${error.message}`)
      }
    } finally {
      running = false
    }
  }
  try {
    while (true) {
      renderer.writePrompt()
      slashSuggester.attach()
      const { text, eof } = await input.readLine('')
      slashSuggester.detach()
      if (eof) {
        saveCurrentSession(null)
        renderer.newline()
        renderer.info('Goodbye.')
        input.close()
        break
      }
      const trimmed = text.trim()
      if (!trimmed) continue
      let pendingPrompt: string | null = null
      if (trimmed === '/plan' || trimmed.startsWith('/plan ')) {
        const planTask = trimmed.slice(5).trim()
        if (!planTask) {
          renderer.warn('Usage: /plan <task description>')
          continue
        }
        if (!await submitPrompt(trimmed)) continue
        await runPlanMode(planTask, engine, planConfig, renderer, input, history, cwd)
        continue
      }
      if (trimmed.startsWith('/')) {
        if (trimmed === '/') {
          const { listCommands } = await import('../commands/index.js')
          const cmds = listCommands()
          renderer.newline()
          for (const cmd of cmds) {
            process.stdout.write(
              '  \x1b[36m/' +
                cmd.name.padEnd(16) +
                '\x1b[0m \x1b[2m' +
                cmd.description +
                '\x1b[0m\n',
            )
          }
          process.stdout.write('\n  \x1b[2mAlso: /plan <task>, /<skill_name>\x1b[0m\n\n')
          continue
        }
        const partialName = trimmed.slice(1).split(/\s+/)[0] ?? ''
        const { getCommand: _getCmd, listCommands: _listCmds } =
          await import('../commands/index.js')
        const exactCmd = _getCmd(partialName)
        if (!exactCmd && !skills.has(partialName) && partialName && !trimmed.includes(' ')) {
          const allCmds = _listCmds()
          const matches = allCmds.filter(
            (c) =>
              c.name.startsWith(partialName) ||
              (c.aliases ?? []).some((a) => a.startsWith(partialName)),
          )
          const skillMatches = [...skills.values()].filter((s) => s.name.startsWith(partialName))
          if (matches.length > 0) {
            renderer.newline()
            process.stdout.write('  \x1b[2mDid you mean?\x1b[0m\n')
            for (const m of matches) {
              process.stdout.write(
                '  \x1b[36m/' + m.name.padEnd(16) + '\x1b[0m \x1b[2m' + m.description + '\x1b[0m\n',
              )
            }
            for (const s of skillMatches) {
              process.stdout.write(
                '  \x1b[36m/' + s.name.padEnd(16) + '\x1b[0m \x1b[2m' + s.description + '\x1b[0m\n',
              )
            }
            renderer.newline()
          } else if (skillMatches.length > 0) {
            renderer.newline()
            process.stdout.write('  \x1b[2mDid you mean?\x1b[0m\n')
            for (const s of skillMatches) {
              process.stdout.write(
                '  \x1b[36m/' + s.name.padEnd(16) + '\x1b[0m \x1b[2m' + s.description + '\x1b[0m\n',
              )
            }
            renderer.newline()
          } else {
            renderer.warn('Unknown command: ' + trimmed + '. Type / for available commands.')
          }
          continue
        }
        let blockedSkill = false
        const slashCtx: SlashCommandContext = {
          engine,
          renderer,
          history,
          cwd,
          sessionDir: currentSessionDir,
          setHistory: (msgs: OpenAIMessage[]) => {
            history.length = 0
            history.push(...msgs)
          },
          runPrompt: (p: string) => {
            pendingPrompt = p
          },
          getSkillsText,
          getSessionsText,
          persistPermissions: (mode, rules) => {
            saveProjectSettings(cwd, { permissions: { mode, rules } })
            return getProjectSettingsPath(cwd)
          },
          resolveSkillPrompt: (name, args) => {
            if (!skills.has(name)) return null
            const invocation = skillRuntime.resolveSkillInvocation(name, args, 'user')
            renderer.info(formatSkillInvocation(invocation))
            blockedSkill = !invocation.eligible
            return invocation.eligible ? invocation.prompt : null
          },
          loadSession: (name: string) => loadSessionByRef(name),
        }
        const slashResult = await dispatchSlashCommand(trimmed, slashCtx)
        if (slashResult !== null) {
          if (slashResult.type === 'exit') {
            saveCurrentSession('Failed to persist session on exit')
            input.close()
            break
          }
          if (slashResult.type === 'text') {
            renderer.info(slashResult.value)
          }
          if (slashResult.type === 'prompt') {
            pendingPrompt = slashResult.value
          }
          if (slashResult.type === 'clear-history') {
            history.length = 0
            saveCurrentSession('Failed to persist cleared history')
            renderer.info('Conversation history cleared.')
          }
          if (pendingPrompt) {
            renderer.humanPrompt(
              pendingPrompt.slice(0, 80) + (pendingPrompt.length > 80 ? ' ...' : ''),
            )
            if (!await submitPrompt(pendingPrompt)) continue
            updateProgressLog(cwd, 'running', pendingPrompt.slice(0, 100))
            await runTask(pendingPrompt, [...history], Date.now())
            updateProgressLog(cwd, 'idle', 'waiting for next task')
          }
          continue
        }
        if (blockedSkill) continue
        renderer.warn('Unknown command: ' + trimmed + '. Type / for available commands.')
        continue
      }
      renderer.humanPrompt(trimmed)
      if (!await submitPrompt(trimmed)) continue
      updateProgressLog(cwd, 'running', trimmed.slice(0, 100))
      await runTask(trimmed, [...history], Date.now())
      updateProgressLog(cwd, 'idle', 'waiting for next task')
    }
    if (consolidate) {
      try {
        renderer.info('Consolidating memory...')
        const result = await consolidateSession(
          engine.getModelClient(),
          engine.getModel(),
          consolidate.episodicMemory,
          consolidate.semanticMemory,
          consolidate.config.poor,
          signal,
        )
        if (result.knowledgeExtracted > 0) {
          renderer.info(
            `Memory consolidated: ${result.knowledgeExtracted} entries from ${result.episodes} episodes`,
          )
        }
      } catch (error) {
        void error
      }
    }
  } finally {
    process.stdin.off('keypress', onKeypress)
    process.off('SIGINT', onSigint)
    input.readline?.off('SIGINT', onSigint)
    slashSuggester.detach()
    try {
      sessionState.saveOnExit?.()
    } catch (error) {
      void error
    }
    sessionState.prompt = null
    sessionState.saveOnExit = null
    if (currentSessionDir) {
      try {
        releaseSessionOwnership(currentSessionDir)
      } catch (error) {
        renderer.warn(`Failed to release session: ${(error as Error).message}`)
      }
    }
    try {
      input.close()
    } catch (error) {
      void error
    }
  }
}
