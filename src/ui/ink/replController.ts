import type { UIStore } from './store.js'
import type { ExecutionEngine } from '../../core/engine.js'
import type { OpenAIMessage } from '../../core/types.js'
import type { Renderer } from '../renderer.js'
import { AgentSessionClient } from '../../core/agentSessionClient.js'
import { InkRenderer } from './inkRenderer.js'
import { dispatchSlashCommand, type SlashCommandContext } from '../../commands/index.js'
import {
  listSessions,
  resolveSessionPath,
} from '../../core/sessionManager.js'
import { formatApiError } from '../../utils/apiError.js'
import { normalizeOutcome, type OutcomeStatus } from '../../core/outcome.js'
import { refreshGitBranch } from './gitInfo.js'
import { formatSkillInvocation, type SkillInvocationResolver } from '../../skills/runtime.js'

export interface InkReplControllerOptions {
  store: UIStore
  engine: ExecutionEngine
  inkRenderer: Renderer
  skills: Array<{ name: string; description: string }>
  resolveSkillInvocation?: SkillInvocationResolver
  onUserPromptSubmit?: (prompt: string, signal?: AbortSignal) => void | Promise<unknown>
  sessionDir?: string
  cwd: string
  resumedHistory?: OpenAIMessage[]
  onExit: () => void
  client?: AgentSessionClient
  onClient?: (client: AgentSessionClient) => void
}

export interface InkReplTurnResult {
  newHistory: OpenAIMessage[]
  reason: string
  status?: OutcomeStatus
}

export interface InkReplController {
  getHistory: () => OpenAIMessage[]
  getModelHistory: () => OpenAIMessage[]
  runTurn: (
    prompt: string,
    images?: Array<{ path: string; dataUrl: string }>,
    displayPrompt?: string,
  ) => Promise<InkReplTurnResult>
  dispatchSlash: (input: string) => Promise<boolean>
  initialize: () => Promise<void>
  interrupt: () => Promise<void>
  release: () => Promise<void>
}

const modelChoices = [
  { label: 'glm-4.6', description: 'ZhipuAI GLM-4.6 (default)', value: 'glm-4.6' },
  { label: 'glm-4.5', description: 'ZhipuAI GLM-4.5', value: 'glm-4.5' },
  { label: 'gpt-4o', description: 'OpenAI GPT-4o', value: 'gpt-4o' },
  { label: 'gpt-4o-mini', description: 'OpenAI GPT-4o-mini (fast)', value: 'gpt-4o-mini' },
  {
    label: 'claude-sonnet-4-20250514',
    description: 'Claude Sonnet 4',
    value: 'claude-sonnet-4-20250514',
  },
  { label: 'deepseek-chat', description: 'DeepSeek Chat (cheap)', value: 'deepseek-chat' },
]

export function createInkReplController(opts: InkReplControllerOptions): InkReplController {
  const { store } = opts
  const eventRenderer = new InkRenderer(store)
  const client = opts.client ?? new AgentSessionClient({
    engine: opts.engine, observer: opts.inkRenderer, cwd: opts.cwd,
    sessionDir: opts.sessionDir, history: opts.resumedHistory,
    onEvent: event => eventRenderer.agentEvent(event),
  })
  opts.onClient?.(client)
  let blockedSkill = false
  let turnRunning = false

  async function setHistory(messages: OpenAIMessage[]): Promise<void> {
    await client.replaceHistory(messages)
    store.clearMessages()
  }

  async function loadSessionByRef(name: string): Promise<OpenAIMessage[] | null> {
    try {
      const sessionPath = resolveSessionPath(opts.cwd, name)
      const loaded = await client.switchSession(sessionPath)
      store.clearMessages()
      return loaded
    } catch (error) {
      store.addError(formatApiError(error).detail)
      return null
    }
  }

  const slashContext: SlashCommandContext = {
    get engine() { return client.engine },
    renderer: opts.inkRenderer,
    get history() {
      return client.getHistory()
    },
    cwd: opts.cwd,
    get sessionDir() {
      return client.sessionDir
    },
    setHistory,
    getModelHistory: () => client.getModelWindow(),
    setModelWindow: messages => client.replaceModelWindow(messages),
    recoverSession: async () => {
      const history = await client.recover()
      store.clearMessages()
      return history
    },
    runPrompt: (prompt) => {
      void runTurn(prompt)
    },
    getSkillsText: () =>
      opts.skills.length === 0
        ? 'No skills available.'
        : opts.skills.map((skill) => `/${skill.name.padEnd(16)} ${skill.description}`).join('\n'),
    resolveSkillPrompt: (name, args) => {
      if (!opts.resolveSkillInvocation || !opts.skills.some((skill) => skill.name === name)) return null
      const invocation = opts.resolveSkillInvocation(name, args, 'user')
      store.addInfo(formatSkillInvocation(invocation))
      blockedSkill = !invocation.eligible
      return invocation.eligible ? invocation.prompt : null
    },
    getSessionsText: () => {
      const sessions = listSessions(opts.cwd)
      return sessions.length === 0
        ? 'No saved sessions found.'
        : sessions
            .slice(0, 10)
            .map((session) => `  ${session.name}  ${session.messages} msgs`)
            .join('\n')
    },
    loadSession: loadSessionByRef,
  }

  async function runTurn(
    prompt: string,
    images?: Array<{ path: string; dataUrl: string }>,
    displayPrompt = prompt,
  ): Promise<InkReplTurnResult> {
    if (turnRunning) {
      store.addWarn('A turn is already running. Interrupt it before starting another.')
      return { newHistory: client.getHistory(), reason: 'error', status: 'failed' }
    }
    turnRunning = true
    store.setRunning(true)
    store.setSpinner(true, 'Thinking')
    try {
      eventRenderer.setUserPrompt(displayPrompt)
      const result = await client.runTurn(prompt, images, opts.onUserPromptSubmit ? signal => opts.onUserPromptSubmit!(prompt, signal) : undefined)
      const tracker = client.engine.getCostTracker()
      store.setCost(tracker.getTotalCost(), tracker.getTotalAPICalls(), tracker.getUsageSummary?.()?.unknownPriceRequestCount ?? 0)
      const status = normalizeOutcome(result.result)
      if (status !== 'completed') {
        const detail = result.result.verification?.output ?? result.result.output
        if (status === 'cancelled') store.addInfo('Task cancelled')
        else store.addError(`Task ${status}${detail ? `: ${detail}` : ''}`)
      }
      return { newHistory: result.newHistory, reason: result.result.reason, status }
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        store.addInfo('Task cancelled')
        return { newHistory: client.getHistory(), reason: 'interrupted', status: 'cancelled' }
      }
      const formatted = formatApiError(error)
      store.addError(
        `${formatted.title}: ${formatted.detail}${formatted.hint ? ' ' + formatted.hint : ''}`,
      )
      return { newHistory: client.getHistory(), reason: 'error', status: 'failed' }
    } finally {
      refreshGitBranch()
      turnRunning = false
      store.setRunning(false)
      store.setSpinner(false)
    }
  }

  async function resumeSession(): Promise<void> {
    const sessions = listSessions(opts.cwd)
    if (sessions.length === 0) {
      store.addInfo('No saved sessions found.')
      return
    }
    const items = sessions.slice(0, 20).map((session) => ({
      label: session.name,
      description: `${session.messages} msgs`,
      value: session.name,
    }))
    const selected = await store.showSelectPicker('Resume Session', items)
    if (!selected) return
    const loaded = await slashContext.loadSession?.(selected)
    if (loaded) {
      store.addInfo(`Resumed session: ${selected} (${loaded.length} messages)`)
    } else {
      store.addError(`Failed to load session: ${selected}`)
    }
  }

  async function selectModel(): Promise<void> {
    const currentModel = client.engine.getModel()
    const items = modelChoices.map((model) => ({
      ...model,
      description:
        model.value === currentModel ? `${model.description} ← current` : model.description,
    }))
    const selected = await store.showSelectPicker('Switch Model', items)
    if (selected && selected !== currentModel) {
      client.engine.setModel(selected)
      store.setModel(selected)
      store.addInfo(`Switched model: ${selected}`)
    }
  }

  async function dispatchSlash(input: string): Promise<boolean> {
    try {
      return await performSlash(input)
    } catch (error) {
      const formatted = formatApiError(error)
      store.addError(`${formatted.title}: ${formatted.detail}${formatted.hint ? ' ' + formatted.hint : ''}`)
      return true
    }
  }

  async function performSlash(input: string): Promise<boolean> {
    if (turnRunning) {
      store.addWarn('Wait for the current turn to finish before running a command.')
      return true
    }
    const trimmed = input.trim()
    if (!/^\/(?:recover|exit|quit|q)(?:\s|$)/.test(trimmed)) await client.initialize()
    if (trimmed === '/resume' || trimmed === '/r') {
      await resumeSession()
      return true
    }
    if (trimmed === '/model') {
      await selectModel()
      return true
    }
    blockedSkill = false
    const result = await dispatchSlashCommand(input, slashContext)
    refreshGitBranch()
    if (result === null) return blockedSkill
    switch (result.type) {
      case 'text':
        store.addInfo(result.value)
        break
      case 'exit':
        opts.onExit()
        break
      case 'prompt':
        void runTurn(result.value)
        break
      case 'clear-history':
        break
      case 'noop':
        break
    }
    return true
  }

  return {
    getHistory: () => client.getHistory(), getModelHistory: () => client.getModelWindow(), runTurn, dispatchSlash,
    initialize: () => client.initialize(), interrupt: () => client.interrupt(), release: () => client.dispose(),
  }
}
