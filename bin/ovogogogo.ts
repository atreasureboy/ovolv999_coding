#!/usr/bin/env node
import { createHash } from 'crypto'
import { realpathSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { ArgError, parseArgs, type Args } from '../src/cli/args.js'
import { VERSION, buildVersion, resolveApiEnvironment } from '../src/cli/environment.js'
import { printHelp } from '../src/cli/help.js'
import { loadEnvironment } from '../src/cli/loadEnvironment.js'
import { resolveResumePath } from '../src/cli/paths.js'
import { createCliPermissionManager } from '../src/cli/permissions.js'
import { updateProgressLog } from '../src/cli/progress.js'
import { runRepl } from '../src/cli/repl.js'
import { SESSION_SUBCOMMANDS, handleSessionSubcommand } from '../src/cli/sessions.js'
import type { CliSessionState } from '../src/cli/sessionState.js'
import { runSingleTask } from '../src/cli/tasks.js'
import '../src/commands/builtin.js'
import { HookRunner, NoopHookRunner } from '../src/config/hooks.js'
import { loadOvogoMd } from '../src/config/ovogomd.js'
import { loadProjectConfig } from '../src/config/projectConfig.js'
import { detectProjectContext, formatProjectContext } from '../src/config/projectContext.js'
import { loadSettings } from '../src/config/settings.js'
import { recordBackgroundOutcome } from '../src/core/backgroundSession.js'
import { resolveContextWindow } from '../src/core/compact.js'
import { ExecutionEngine } from '../src/core/engine.js'
import { EpisodicMemory } from '../src/core/episodicMemory.js'
import { EventLog } from '../src/core/eventLog.js'
import { getCurrentMode, getVerbosityPrompt } from '../src/core/modes.js'
import { globalModuleRegistry } from '../src/core/moduleRegistry.js'
import { outcomeExitCode, settleWithin } from '../src/core/outcome.js'
import { PermissionManager } from '../src/core/permissionSystem.js'
import { SemanticMemory } from '../src/core/semanticMemory.js'
import {
  AmbiguousSessionError,
  SessionNotFoundError,
  claimSessionOwnership,
  createSessionDir,
  findLatestSession,
  loadSession,
  saveSession,
} from '../src/core/sessionManager.js'
import type { AgentChildEngineFactory, EngineConfig, OpenAIMessage } from '../src/core/types.js'
import { getMemoryDir, getMemoryStats } from '../src/memory/index.js'
import { CriticModule } from '../src/modules/critic.js'
import { McpModule } from '../src/modules/mcp.js'
import { MemoryModule } from '../src/modules/memory.js'
import { ReflectionModule } from '../src/modules/reflection.js'
import { WorkspaceModule } from '../src/modules/workspace.js'
import { buildFullSystemPrompt } from '../src/prompts/system.js'
import { formatSkillIndex, loadSkills } from '../src/skills/loader.js'
import { createTerminalAskUserHandler } from '../src/tools/askUser.js'
import { createLoadSkillTool } from '../src/tools/loadSkill.js'
import type { InkRenderer } from '../src/ui/ink/inkRenderer.js'
import type { UIStore } from '../src/ui/ink/store.js'
import { readStdin } from '../src/ui/input.js'
import { Renderer } from '../src/ui/renderer.js'
import { tmuxLayout } from '../src/ui/tmuxLayout.js'
export { printHelp } from '../src/cli/help.js'
export { expandHome, normalizeCwd, resolveResumePath } from '../src/cli/paths.js'
export { createCliPermissionManager } from '../src/cli/permissions.js'
export { runSingleTask } from '../src/cli/tasks.js'
loadEnvironment(import.meta.url)
async function main(): Promise<void> {
  const sessionState: CliSessionState = { prompt: null, saveOnExit: null }
  const { handleRuntimeCommand } = await import('../src/core/runtimeRecovery.js')
  if (await handleRuntimeCommand(process.argv.slice(2))) return
  const sub = SESSION_SUBCOMMANDS.get(process.argv[2])
  if (sub) {
    await handleSessionSubcommand(sub, process.argv.slice(3))
    return
  }
  const { initChildLogCapture } = await import('../src/core/backgroundSession.js')
  initChildLogCapture()
  let args: Args
  try {
    args = parseArgs(process.argv)
  } catch (error) {
    if (!(error instanceof ArgError)) throw error
    process.stderr.write(error.message + '\n')
    process.exit(1)
  }
  const {
    task,
    model,
    maxIter,
    cwd: rawCwd,
    help,
    version,
    loop,
    loopMaxIters,
    continueSession,
    resumeSession,
    ink,
    pipe,
    pipeFormat,
    bg,
  } = args
  const cwd = resolve(rawCwd)
  const apiEnvironment = resolveApiEnvironment()
  const skills = loadSkills(cwd)
  if (version) {
    process.stdout.write(`${buildVersion(import.meta.url)}\n`)
    process.exit(0)
  }
  if (help && !pipe) {
    printHelp(skills)
    process.exit(0)
  }
  if (pipe) {
    if (help) {
      const { getPipeHelp } = await import('../src/integrations/pipeMode.js')
      process.stdout.write(getPipeHelp() + '\n')
      process.exit(0)
    }
    const apiKey = apiEnvironment.apiKey
    if (!apiKey) {
      process.stderr.write('Error: no API key configured for pipe mode\n')
      process.exit(1)
    }
    const { readStdin, executePipe, formatPipeOutput } =
      await import('../src/integrations/pipeMode.js')
    let stdinContent = ''
    if (!process.stdin.isTTY) {
      try {
        stdinContent = await readStdin()
      } catch (err) {
        process.stderr.write(`Error reading stdin: ${(err as Error).message}\n`)
        process.exit(1)
      }
    }
    if (!task && !stdinContent.trim()) {
      process.stderr.write('Error: no prompt or stdin input provided\n')
      process.exit(1)
    }
    const OpenAI = (await import('openai')).default
    const { createModelGateway } = await import('../src/core/modelGateway.js')
    const client = createModelGateway(
      new OpenAI({ apiKey, baseURL: apiEnvironment.baseURL, maxRetries: 0 }),
      {
        model,
        apiKey,
        baseURL: apiEnvironment.baseURL,
        cwd,
        permissionMode: 'deny',
        maxIterations: 1,
      },
      () => null,
    )
    const llmCall = async (prompt: string): Promise<string> => {
      try {
        const resp = await client.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: 'You are a helpful coding assistant. Respond concisely.' },
            { role: 'user', content: prompt },
          ],
        })
        return resp.choices[0]?.message?.content ?? ''
      } catch (err) {
        process.stderr.write(`API error: ${(err as Error).message}\n`)
        process.exit(2)
      }
    }
    const result = await executePipe(
      { cwd, prompt: task, format: pipeFormat },
      stdinContent,
      llmCall,
    )
    process.stdout.write(formatPipeOutput(result, pipeFormat))
    process.stdout.write('\n')
    process.exit(0)
  }
  const apiKey = apiEnvironment.apiKey
  if (!apiKey) {
    process.stderr.write(
      '\x1b[31mError:\x1b[0m no API key is configured.\n' +
        'Set OPENAI_API_KEY, or configure MiniMax through ANTHROPIC_AUTH_TOKEN.\n',
    )
    process.exit(1)
  }
  if (bg) {
    if (!task) {
      process.stderr.write('Error: --bg requires a task to run in the background\n')
      process.exit(1)
    }
    const { startBackgroundSession, formatSessionDetail, loadMetadata } =
      await import('../src/core/backgroundSession.js')
    const result = await startBackgroundSession({ task, cwd, model })
    const meta = loadMetadata(result.sessionId)
    if (meta) {
      process.stdout.write(formatSessionDetail(meta) + '\n')
      process.stdout.write(`\nSession ${result.sessionId} started in the background.\n`)
      process.stdout.write(`Use 'ovolv999 logs ${result.sessionId}' to view output.\n`)
      process.stdout.write(`Use 'ovolv999 ps' to list sessions.\n`)
    }
    process.exit(0)
  }
  const renderer = new Renderer()
  renderer.banner(VERSION, model)
  renderer.info(`cwd: ${cwd}`)
  const settings = loadSettings(cwd)
  const projectConfig = loadProjectConfig(cwd)
  if (projectConfig) {
    renderer.info(`Project config: .ovolv999.json loaded`)
  }
  const hookRunner = settings.hooks
    ? new HookRunner(settings.hooks, { sink: { warn: (m) => renderer.warn(m) } })
    : new NoopHookRunner()
  const hookTypes = [
    'PreToolCall',
    'PostToolCall',
    'UserPromptSubmit',
    'OnError',
    'OnComplete',
    'OnContextOverflow',
  ] as const
  const hasHooks = hookTypes.some((t) => (settings.hooks?.[t]?.length ?? 0) > 0)
  if (hasHooks) {
    const count = hookTypes.reduce((sum, t) => sum + (settings.hooks?.[t]?.length ?? 0), 0)
    renderer.info(`Hooks: ${count} hook(s) loaded from .ovogo/settings.json`)
  }
  const customSkills = [...skills.values()].filter((s) => s.source !== 'builtin')
  if (customSkills.length > 0) {
    renderer.info(`Skills: ${customSkills.length} custom skill(s) loaded — type /skills to list`)
  }
  const ovogoMdFiles = loadOvogoMd(cwd)
  if (ovogoMdFiles.length > 0) {
    const labels = ovogoMdFiles.map((f) => f.type).join(', ')
    renderer.info(`OVOGO.md: ${ovogoMdFiles.length} file(s) loaded (${labels})`)
  }
  const memoryDir = getMemoryDir(cwd)
  const memStats = getMemoryStats(memoryDir)
  if (memStats.hasIndex) {
    renderer.info(
      `Memory: ${memStats.entryCount} entr${memStats.entryCount !== 1 ? 'ies' : 'y'} — ${memoryDir}`,
    )
  } else {
    renderer.info(`Memory: initialized — ${memoryDir}`)
  }
  const taskContext = settings.taskContext
  if (taskContext) {
    renderer.info(`Task: ${taskContext.name ?? '未命名'} · 阶段: ${taskContext.phase ?? '未设置'}`)
    if (taskContext.scope && taskContext.scope.length > 0) {
      renderer.info(`Scope: ${taskContext.scope.join(', ')}`)
    }
  }
  const permissionManager = createCliPermissionManager(
    settings.permissions,
    projectConfig?.permissionMode,
  )
  renderer.info(`Permissions: ${permissionManager.formatMode()}`)
  let sessionDir: string
  let resumedHistory: OpenAIMessage[] = []
  if (resumeSession) {
    try {
      sessionDir = resolveResumePath(cwd, resumeSession)
    } catch (err: unknown) {
      if (err instanceof AmbiguousSessionError) {
        renderer.error(err.message)
        for (const m of err.matches) renderer.error(`  - ${m}`)
        process.exit(1)
      }
      if (err instanceof SessionNotFoundError) {
        renderer.error(err.message)
        process.exit(1)
      }
      throw err
    }
    claimSessionOwnership(sessionDir)
    resumedHistory = loadSession(sessionDir)
    renderer.info(`Resumed session: ${sessionDir} (${resumedHistory.length} messages)`)
  } else if (continueSession) {
    const latest = findLatestSession(cwd)
    if (latest) {
      sessionDir = latest
      claimSessionOwnership(sessionDir)
      resumedHistory = loadSession(sessionDir)
      renderer.info(`Continued session: ${sessionDir} (${resumedHistory.length} messages)`)
    } else {
      sessionDir = createSessionDir(cwd)
      renderer.info(`No previous session found — starting new: ${sessionDir}`)
    }
  } else {
    sessionDir = createSessionDir(cwd)
  }
  renderer.info(`Session dir: ${sessionDir}`)
  const agentLogDir = join(sessionDir, 'agent-logs')
  const layoutReady = tmuxLayout.init(agentLogDir)
  if (layoutReady) {
    renderer.info(`Agent 监控: ${tmuxLayout.sessionHint()}`)
  }
  const projectCtx = detectProjectContext(cwd)
  const projectCtxSection = formatProjectContext(projectCtx)
  if (projectCtx.git?.branch) {
    renderer.info(
      `Git: ${projectCtx.git.branch} · ${projectCtx.git.modifiedCount ?? 0} modified · ${projectCtx.git.stagedCount ?? 0} staged`,
    )
  }
  const skillIndex = formatSkillIndex(skills)
  const modesDir = join(homedir(), '.ovogo', 'modes')
  const mode = getCurrentMode(modesDir)
  const verbosityPrompt = getVerbosityPrompt(mode.verbosity)
  const modePrompt = [mode.systemPrompt, verbosityPrompt].filter(Boolean).join('\n\n')
  const systemPrompt = buildFullSystemPrompt(
    cwd,
    ovogoMdFiles,
    modePrompt,
    taskContext,
    sessionDir,
    skillIndex,
    projectCtxSection,
  )
  const eventLog = new EventLog(sessionDir)
  renderer.info(`EventLog: ${eventLog.getFilePath()}`)
  const projectSlug =
    cwd.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 24) +
    '_' +
    createHash('sha256').update(cwd).digest('hex').slice(0, 8)
  const semanticMemory = new SemanticMemory(join(homedir(), '.ovogo', 'projects', projectSlug))
  const episodicMemory = new EpisodicMemory(join(homedir(), '.ovogo', 'projects', projectSlug))
  globalModuleRegistry.register(
    'memory',
    (ctx) => new MemoryModule(ctx.config.semanticMemory!, ctx.config.episodicMemory!),
  )
  globalModuleRegistry.register(
    'critic',
    (ctx) => new CriticModule(ctx.client, ctx.model, ctx.config),
  )
  globalModuleRegistry.register('workspace', (ctx) => new WorkspaceModule(ctx.config.sessionDir))
  globalModuleRegistry.register(
    'reflection',
    (ctx) => new ReflectionModule(ctx.client, ctx.model, ctx.config.semanticMemory!, ctx.config),
  )
  globalModuleRegistry.register('mcp', () => new McpModule())
  const maxCtxTokens = process.env.OVOGO_MAX_CONTEXT_TOKENS
    ? parseInt(process.env.OVOGO_MAX_CONTEXT_TOKENS, 10)
    : undefined
  const loadSkillTool = createLoadSkillTool(skills)
  const agentFactory: AgentChildEngineFactory = (childConfig, childRenderer) =>
    new ExecutionEngine(childConfig, childRenderer as Renderer)
  let uiStore: UIStore | undefined
  let inkRendererInstance: InkRenderer | undefined
  if (ink) {
    const { UIStore: UIStoreClass } = await import('../src/ui/ink/store.js')
    const { InkRenderer: InkRendererClass } = await import('../src/ui/ink/inkRenderer.js')
    uiStore = new UIStoreClass()
    inkRendererInstance = new InkRendererClass(uiStore)
  }
  const config: EngineConfig = {
    model: projectConfig?.model ?? model,
    apiKey,
    baseURL: apiEnvironment.baseURL,
    maxIterations: projectConfig?.maxIterations ?? maxIter,
    cwd,
    permissionMode: projectConfig?.permissionMode ?? 'auto',
    permissionManager,
    hookRunner,
    systemPrompt: projectConfig?.systemPrompt
      ? systemPrompt + '\n\n' + projectConfig.systemPrompt
      : systemPrompt,
    sessionDir,
    maxContextTokens: projectConfig?.maxContextTokens ?? maxCtxTokens,
    temperature:
      projectConfig?.temperature ??
      (process.env.OVOGO_TEMPERATURE ? parseFloat(process.env.OVOGO_TEMPERATURE) : undefined),
    maxOutputTokens: process.env.OVOGO_MAX_OUTPUT_TOKENS
      ? parseInt(process.env.OVOGO_MAX_OUTPUT_TOKENS, 10)
      : undefined,
    poor:
      projectConfig?.poor ??
      settings.poor ??
      (process.env.OVOGO_POOR === '1' ? { enabled: true } : undefined),
    mcp: settings.mcp,
    eventLog,
    semanticMemory,
    episodicMemory,
    extraTools: skills.size > 0 ? [loadSkillTool] : [],
    enabledModules:
      projectConfig?.enabledModules ??
      (settings.mcp?.servers?.length
        ? ['memory', 'critic', 'workspace', 'reflection', 'mcp']
        : ['memory', 'critic', 'workspace', 'reflection']),
    agentFactory,
    askUserQuestion: createTerminalAskUserHandler({
      prompt: {
        get isTTY(): boolean {
          if (sessionState.prompt) return sessionState.prompt.isTTY
          return Boolean(process.stdout.isTTY && process.stdin.isTTY)
        },
        readLine: (p, signal) =>
          sessionState.prompt
            ? sessionState.prompt.readLine(p, signal)
            : Promise.resolve({ text: '', eof: true }),
        close: () => sessionState.prompt?.close(),
      },
      writeOut: (s) => process.stdout.write(s),
    }),
    exitPlanMode:
      uiStore || (process.stdin.isTTY && process.stdout.isTTY)
        ? async (plan: string): Promise<boolean> => {
            if (uiStore) {
              return uiStore.showPlanApproval(plan)
            }
            if (!sessionState.prompt || !sessionState.prompt.isTTY) {
              throw new Error(
                'Plan approval is unavailable; an interactive approval channel is required.',
              )
            }
            process.stdout.write('\n\x1b[95m❯❯ Plan:\x1b[0m\n')
            process.stdout.write(plan + '\n')
            process.stdout.write('\n\x1b[93mApprove this plan? (y/n):\x1b[0m ')
            const { text: answer, eof } = await sessionState.prompt.readLine('')
            if (eof) {
              process.stdout.write('\n')
              return false
            }
            return answer.trim().toLowerCase().startsWith('y')
          }
        : undefined,
    requestPermission: uiStore
      ? async (toolName, input, riskLevel) => {
          const preview =
            toolName === 'Bash' && typeof input.command === 'string'
              ? input.command
              : JSON.stringify(input).slice(0, 100)
          const result = await uiStore.showPermissionDialog({ toolName, preview, riskLevel })
          if (result.alwaysAllow) {
            permissionManager.addRule({
              toolName,
              ruleContent: '*',
              behavior: 'allow',
              source: 'user',
            })
          }
          return { approved: result.approved, feedback: result.feedback }
        }
      : undefined,
  }
  const planPermissionManager = new PermissionManager()
  planPermissionManager.setMode('plan')
  const planConfig: EngineConfig = {
    ...config,
    planMode: true,
    permissionManager: planPermissionManager,
    enabledModules: ['memory', 'workspace'],
  }
  const engine = new ExecutionEngine(config, inkRendererInstance ? inkRendererInstance : renderer)
  const { markBackgroundReady } = await import('../src/core/backgroundSession.js')
  markBackgroundReady()
  let cleanupPromise: Promise<void> | undefined
  const lifecycleController = new AbortController()
  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise
    cleanupPromise = (async () => {
      try {
        sessionState.saveOnExit?.()
      } catch (error) {
        renderer.warn('Session cleanup: ' + (error as Error).message)
      }
      try {
        await settleWithin(
          Promise.resolve().then(() => engine.dispose()),
          3000,
        )
      } catch (error) {
        process.exitCode = 2
        updateProgressLog(cwd, 'blocked', 'Cleanup did not finish; resources need attention')
        recordBackgroundOutcome('blocked')
        renderer.error('Unfinished resources during cleanup: ' + (error as Error).message)
      } finally {
        try {
          tmuxLayout.destroy()
        } catch (error) {
          renderer.warn(`Terminal cleanup: ${(error as Error).message}`)
        }
      }
      const costTracker = engine.getCostTracker()
      if (costTracker.getTotalAPICalls() > 0)
        process.stdout.write('\n' + costTracker.formatSummary() + '\n')
    })()
    return cleanupPromise
  }
  const saveAtExit = (): void => {
    try {
      sessionState.saveOnExit?.()
    } catch (error) {
      process.stderr.write(`Session persistence failed: ${(error as Error).message}\n`)
    }
  }
  const terminate = (): void => {
    lifecycleController.abort()
    engine.abort()
    process.exitCode = 130
    updateProgressLog(cwd, 'cancelled', 'Termination requested; waiting for cleanup')
    recordBackgroundOutcome('cancelled')
    void cleanup().finally(() => process.exit(Number(process.exitCode) || 130))
  }
  process.on('exit', saveAtExit)
  process.on('SIGTERM', terminate)
  process.on('SIGHUP', terminate)
  if (loop || task || !process.stdin.isTTY) process.on('SIGINT', terminate)
  try {
    sessionState.saveOnExit = (): void => {
      if (!sessionDir) return
      try {
        saveSession(sessionDir, resumedHistory)
      } catch (error) {
        void error
      }
    }
    if (!process.stdin.isTTY) {
      const piped = await readStdin()
      if (piped) {
        hookRunner.runUserPromptSubmit(piped)
        await runSingleTask(
          engine,
          renderer,
          piped,
          cwd,
          resumedHistory,
          sessionDir,
          resumedHistory,
        )
        return
      }
    }
    if (loop) {
      const { runLoop } = await import('../src/core/loopEngine.js')
      renderer.info('Loop mode activated — reading .loop/ configuration')
      const outcome = await runLoop(engine, renderer, {
        cwd,
        loopDir: join(cwd, '.loop'),
        maxIters: loopMaxIters,
        signal: lifecycleController.signal,
        sessionDir,
      })
      process.exitCode = outcomeExitCode(outcome.status)
      recordBackgroundOutcome(outcome.status, outcome.verification)
      updateProgressLog(cwd, outcome.status, outcome.verification.output.slice(0, 100))
      return
    }
    if (task) {
      hookRunner.runUserPromptSubmit(task)
      await runSingleTask(engine, renderer, task, cwd, resumedHistory, sessionDir, resumedHistory)
      return
    }
    if (ink && uiStore && inkRendererInstance) {
      const { runInkRepl } = await import('../src/ui/ink/runInkRepl.js')
      const skillsArray = [...skills.values()].map((s) => ({
        name: s.name,
        description: s.description,
      }))
      await runInkRepl({
        store: uiStore,
        engine,
        inkRenderer: inkRendererInstance as unknown as Renderer,
        version: VERSION,
        model,
        skills: skillsArray,
        cwd,
        sessionDir,
        resumedHistory,
        maxContextTokens: resolveContextWindow(config.model, config.maxContextTokens),
      })
      return
    }
    await runRepl(
      sessionState,
      engine,
      planConfig,
      renderer,
      cwd,
      skills,
      hookRunner,
      {
        config,
        semanticMemory,
        episodicMemory,
      },
      sessionDir,
      resumedHistory,
      lifecycleController.signal,
    )
  } finally {
    await cleanup()
    process.off('exit', saveAtExit)
    process.off('SIGTERM', terminate)
    process.off('SIGHUP', terminate)
    process.off('SIGINT', terminate)
  }
}
function safeRealpath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}
const isMainModule = ((): boolean => {
  if (!process.argv[1]) return false
  try {
    const argvResolved = safeRealpath(resolve(process.argv[1]))
    const target = pathToFileURL(argvResolved).href
    const importUrlPath = safeRealpath(fileURLToPath(import.meta.url))
    return target === import.meta.url || pathToFileURL(importUrlPath).href === target
  } catch {
    return false
  }
})()
if (isMainModule) {
  main().catch((err: unknown) => {
    process.stderr.write(`\x1b[31mFatal:\x1b[0m ${(err as Error).message}\n`)
    process.exit(1)
  })
}
