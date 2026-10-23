import { dispatchSlashCommand, listCommands, type SlashCommandContext } from '../commands/index.js'
import { persistCliPermissions } from './permissions.js'
import { ExecutionEngine } from '../core/engine.js'
import { AgentSessionClient } from '../core/agentSessionClient.js'
import { bindEngineSession } from '../core/engineSession.js'
import type { EpisodicMemory } from '../core/episodicMemory.js'
import { normalizeOutcome } from '../core/outcome.js'
import type { SemanticMemory } from '../core/semanticMemory.js'
import {
  AmbiguousSessionError,
  SessionNotFoundError,
  createSessionDir,
  listSessions,
  resolveSessionPath,
} from '../core/sessionManager.js'
import type { EngineConfig, OpenAIMessage } from '../core/types.js'
import { consolidateSession } from '../modules/reflection.js'
import type { Skill } from '../skills/loader.js'
import { createSkillRuntime, formatSkillInvocation } from '../skills/runtime.js'
import { createAgentEventRenderer } from '../ui/agentEventRenderer.js'
import { InputHandler } from '../ui/input.js'
import type { Renderer } from '../ui/renderer.js'
import { SlashSuggester } from '../ui/slashSuggest.js'
import { updateProgressLog } from './progress.js'
import type { CliSessionState } from './sessionState.js'
export async function runPlanMode(
  task: string,
  engine: ExecutionEngine,
  planConfig: EngineConfig,
  renderer: Renderer,
  input: InputHandler,
  history: OpenAIMessage[],
  cwd: string,
  executionClient?: AgentSessionClient,
  onActiveClient?: (client: AgentSessionClient | null) => void,
  onPromptSubmit?: (signal: AbortSignal) => Promise<unknown>,
): Promise<void> {
  renderer.planModeStart()
  renderer.humanPrompt(`[PLAN] ${task}`)
  updateProgressLog(cwd, 'planning', task.slice(0, 100))
  const planSessionDir = createSessionDir(cwd)
  const planEngine = new ExecutionEngine(bindEngineSession(planConfig, planSessionDir), renderer)
  const planClient = new AgentSessionClient({ engine: planEngine, observer: renderer, cwd, sessionDir: planSessionDir, history, onEvent: createAgentEventRenderer(renderer) })
  let approvedPlan: string
  try {
    onActiveClient?.(planClient)
    const { result } = await planClient.runTurn(task, undefined, onPromptSubmit)
    const status = normalizeOutcome(result)
    if (status !== 'completed') {
      renderer.warn(`Planning ${status}: ${result.reason}`)
      updateProgressLog(cwd, 'idle', 'waiting for next task')
      return
    }
    approvedPlan = result.output.trim()
    if (!approvedPlan) {
      renderer.warn('Planning returned no plan. Submit the task again before executing.')
      updateProgressLog(cwd, 'idle', 'waiting for next task')
      return
    }
  } catch (err: unknown) {
    renderer.error(`Plan error: ${(err as Error).message}`)
    updateProgressLog(cwd, 'idle', 'waiting for next task')
    return
  } finally {
    await planClient.dispose()
    onActiveClient?.(executionClient ?? null)
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
    const client = executionClient ?? new AgentSessionClient({ engine, observer: renderer, cwd, sessionDir: engine.getConfig().sessionDir, history, onEvent: createAgentEventRenderer(renderer) })
    try {
      onActiveClient?.(client)
      const executionPrompt = `${task}\n\nThe user approved the following plan. Execute it while preserving its scope and constraints:\n\n${approvedPlan}`
      const { result, newHistory } = await client.runTurn(executionPrompt)
      history.length = 0
      history.push(...newHistory)
      const elapsed = ((Date.now() - startMs) / 1000).toFixed(1)
      renderer.info(`${normalizeOutcome(result)} in ${elapsed}s · ${result.reason}`)
    } catch (err: unknown) {
      renderer.error(`Execution error: ${(err as Error).message}`)
    } finally {
      if (!executionClient) await client.dispose()
      onActiveClient?.(executionClient ?? null)
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
    runUserPromptSubmit: (p: string, signal?: AbortSignal) => unknown
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
  const client = new AgentSessionClient({ engine, observer: renderer, cwd, sessionDir, history, onEvent: createAgentEventRenderer(renderer) })
  try { await client.initialize() } catch (error) { renderer.warn(`Session requires recovery: ${(error as Error).message}. Inspect its records, then use /recover --fork.`) }
  history.splice(0, history.length, ...client.getHistory())
  let activeClient: AgentSessionClient | null = client
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
  sessionState.saveOnExit = null
  sessionState.interrupt = () => activeClient?.interrupt() ?? Promise.resolve()
  sessionState.dispose = async () => {
    if (activeClient && activeClient !== client) await activeClient.dispose()
    await client.dispose()
  }
  sessionState.getEngine = () => client.engine
  const onAbort = () => { void Promise.resolve(sessionState.interrupt?.()).catch(() => {}); input.close() }
  signal?.addEventListener('abort', onAbort, { once: true })
  const loadSessionByRef = async (ref: string): Promise<OpenAIMessage[] | null> => {
    try {
      const dir = resolveSessionPath(cwd, ref)
      return await client.switchSession(dir)
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
      void activeClient?.interrupt().catch(error => renderer.warn(`Interruption failed: ${(error as Error).message}`))
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
      void activeClient?.interrupt().catch(error => renderer.warn(`Interruption failed: ${(error as Error).message}`))
      renderer.stopSpinner()
      renderer.warn('Cancelled. Press Ctrl+C again within 1.5s to force exit.')
      return
    }
    renderer.newline()
    renderer.info('Force exit (Ctrl+C x' + sigintCount + '). Durable records are retained.')
    try {
      input.close()
    } catch (error) {
      void error
    }
    process.exit(130)
  }
  process.on('SIGINT', onSigint)
  input.readline?.on('SIGINT', onSigint)
  async function runTask(
    prompt: string,
    startMs: number,
    onPromptSubmit: (signal: AbortSignal) => Promise<unknown>,
  ): Promise<void> {
    running = true
    let currentPrompt = prompt
    let pendingSubmission: typeof onPromptSubmit | undefined = onPromptSubmit
    try {
      while (true) {
        const result = await client.runTurn(currentPrompt, undefined, pendingSubmission)
        pendingSubmission = undefined
        history.length = 0
        history.push(...result.newHistory)
        const status = normalizeOutcome(result.result)
        if (status === 'blocked') {
          renderer.warn('The turn is blocked. Review retained records before continuing.')
          break
        }
        if (status !== 'cancelled' && (result.result.reason === 'interrupted' || result.result.reason === 'error' || status === 'limit_reached')) {
          renderer.writeInterruptPrompt()
          awaitingInput = true
          const { text: feedback, eof } = await input.readLine('')
          awaitingInput = false
          if (eof) {
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
        running = true
        try {
          await runPlanMode(planTask, client.engine, planConfig, renderer, input, history, cwd, client, value => { activeClient = value }, submitSignal => Promise.resolve(hookRunner.runUserPromptSubmit(trimmed, submitSignal)))
        } finally {
          running = false
          activeClient = client
        }
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
          get engine() { return client.engine },
          renderer,
          history,
          cwd,
          get sessionDir() { return client.sessionDir },
          setHistory: async (msgs: OpenAIMessage[]) => {
            await client.replaceHistory(msgs)
            history.length = 0
            history.push(...client.getHistory())
          },
          getModelHistory: () => client.getModelWindow(),
          setModelWindow: msgs => client.replaceModelWindow(msgs),
          recoverSession: async () => {
            const recovered = await client.recover()
            history.splice(0, history.length, ...recovered)
            return recovered
          },
          runPrompt: (p: string) => {
            pendingPrompt = p
          },
          getSkillsText,
          getSessionsText,
          persistPermissions: (mode, rules) => persistCliPermissions(cwd, mode, rules),
          resolveSkillPrompt: (name, args) => {
            if (!skills.has(name)) return null
            const invocation = skillRuntime.resolveSkillInvocation(name, args, 'user')
            renderer.info(formatSkillInvocation(invocation))
            blockedSkill = !invocation.eligible
            return invocation.eligible ? invocation.prompt : null
          },
          loadSession: (name: string) => loadSessionByRef(name),
        }
        let slashResult: Awaited<ReturnType<typeof dispatchSlashCommand>>
        try { slashResult = await dispatchSlashCommand(trimmed, slashCtx) } catch (error) {
          renderer.error(`Command failed: ${error instanceof Error ? error.message : String(error)}`)
          continue
        }
        if (slashResult !== null) {
          if (slashResult.type === 'exit') {
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
            renderer.info('Conversation history cleared.')
          }
          if (pendingPrompt) {
            renderer.humanPrompt(
              pendingPrompt.slice(0, 80) + (pendingPrompt.length > 80 ? ' ...' : ''),
            )
            updateProgressLog(cwd, 'running', pendingPrompt.slice(0, 100))
            const submittedPrompt = pendingPrompt
            await runTask(submittedPrompt, Date.now(), submitSignal => Promise.resolve(hookRunner.runUserPromptSubmit(submittedPrompt, submitSignal)))
            updateProgressLog(cwd, 'idle', 'waiting for next task')
          }
          continue
        }
        if (blockedSkill) continue
        renderer.warn('Unknown command: ' + trimmed + '. Type / for available commands.')
        continue
      }
      renderer.humanPrompt(trimmed)
      updateProgressLog(cwd, 'running', trimmed.slice(0, 100))
      await runTask(trimmed, Date.now(), submitSignal => Promise.resolve(hookRunner.runUserPromptSubmit(trimmed, submitSignal)))
      updateProgressLog(cwd, 'idle', 'waiting for next task')
    }
    if (consolidate) {
      try {
        renderer.info('Consolidating memory...')
        const result = await consolidateSession(
          client.engine.getModelClient(),
          client.engine.getModel(),
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
    signal?.removeEventListener('abort', onAbort)
    process.off('SIGINT', onSigint)
    input.readline?.off('SIGINT', onSigint)
    slashSuggester.detach()
    sessionState.prompt = null
    sessionState.saveOnExit = null
    delete sessionState.interrupt
    delete sessionState.dispose
    try {
      input.close()
    } catch (error) {
      void error
    }
    await client.dispose()
  }
}
