import type { UIStore } from './store.js'
import type { ExecutionEngine } from '../../core/engine.js'
import type { OpenAIMessage } from '../../core/types.js'
import type { Renderer } from '../renderer.js'
import { resolve } from 'node:path'
import { dispatchSlashCommand, type SlashCommandContext } from '../../commands/index.js'
import {
  listSessions,
  claimSessionOwnership,
  loadSession,
  releaseSessionOwnership,
  resolveSessionPath,
  saveSession,
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
  onUserPromptSubmit?: (prompt: string) => void | Promise<unknown>
  sessionDir?: string
  cwd: string
  resumedHistory?: OpenAIMessage[]
  onExit: () => void
}

export interface InkReplTurnResult {
  newHistory: OpenAIMessage[]
  reason: string
  status?: OutcomeStatus
}

export interface InkReplController {
  getHistory: () => OpenAIMessage[]
  runTurn: (
    prompt: string,
    images?: Array<{ path: string; dataUrl: string }>,
  ) => Promise<InkReplTurnResult>
  dispatchSlash: (input: string) => Promise<boolean>
  save: () => void
  release: () => void
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
  const { store, engine } = opts
  let history: OpenAIMessage[] = opts.resumedHistory ? [...opts.resumedHistory] : []
  let currentSessionDir = opts.sessionDir
  let blockedSkill = false

  function setHistory(messages: OpenAIMessage[]): void {
    history = [...messages]
    store.clearMessages()
  }

  function save(): void {
    if (!currentSessionDir) return
    try {
      saveSession(currentSessionDir, history)
    } catch {
      return
    }
  }

  function release(): void {
    if (currentSessionDir) releaseSessionOwnership(currentSessionDir)
  }

  function loadSessionByRef(name: string): OpenAIMessage[] | null {
    let claimedPath: string | undefined
    try {
      const sessionPath = resolveSessionPath(opts.cwd, name)
      const switching = !currentSessionDir || resolve(currentSessionDir) !== resolve(sessionPath)
      claimSessionOwnership(sessionPath)
      if (switching) claimedPath = sessionPath
      const loaded = loadSession(sessionPath)
      if (switching && currentSessionDir) releaseSessionOwnership(currentSessionDir)
      currentSessionDir = sessionPath
      return loaded
    } catch {
      if (claimedPath) releaseSessionOwnership(claimedPath)
      return null
    }
  }

  const slashContext: SlashCommandContext = {
    engine,
    renderer: opts.inkRenderer,
    get history() {
      return history
    },
    cwd: opts.cwd,
    get sessionDir() {
      return currentSessionDir
    },
    setHistory,
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
  ): Promise<InkReplTurnResult> {
    store.setRunning(true)
    store.setSpinner(true, 'Thinking')
    try {
      await opts.onUserPromptSubmit?.(prompt)
      const result = await engine.runTurn(prompt, history, images)
      history = result.newHistory
      const tracker = engine.getCostTracker()
      store.setCost(tracker.getTotalCost(), tracker.getTotalAPICalls(), tracker.getUsageSummary?.()?.unknownPriceRequestCount ?? 0)
      save()
      const status = normalizeOutcome(result.result)
      if (status !== 'completed') {
        const detail = result.result.verification?.output
        store.addError(`Task ${status}${detail ? `: ${detail}` : ''}`)
      }
      return { newHistory: history, reason: result.result.reason, status }
    } catch (error: unknown) {
      if (!(error instanceof Error) || error.name !== 'AbortError') {
        const formatted = formatApiError(error)
        store.addError(
          `${formatted.title}: ${formatted.detail}${formatted.hint ? ' ' + formatted.hint : ''}`,
        )
      }
      return { newHistory: history, reason: 'error' }
    } finally {
      refreshGitBranch()
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
    const loaded = slashContext.loadSession?.(selected)
    if (loaded) {
      setHistory(loaded)
      store.addInfo(`Resumed session: ${selected} (${loaded.length} messages)`)
    } else {
      store.addError(`Failed to load session: ${selected}`)
    }
  }

  async function selectModel(): Promise<void> {
    const currentModel = engine.getModel()
    const items = modelChoices.map((model) => ({
      ...model,
      description:
        model.value === currentModel ? `${model.description} ← current` : model.description,
    }))
    const selected = await store.showSelectPicker('Switch Model', items)
    if (selected && selected !== currentModel) {
      engine.setModel(selected)
      store.setModel(selected)
      store.addInfo(`Switched model: ${selected}`)
    }
  }

  async function dispatchSlash(input: string): Promise<boolean> {
    const trimmed = input.trim()
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
        setHistory([])
        save()
        break
      case 'noop':
        break
    }
    return true
  }

  return { getHistory: () => history, runTurn, dispatchSlash, save, release }
}
