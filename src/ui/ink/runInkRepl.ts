/**
 * runInkRepl — entry point for the Ink-based REPL.
 *
 * Creates the UIStore + InkRenderer, wires them to the ExecutionEngine,
 * and renders the App component tree via Ink.
 *
 * Usage (from bin/ovogogogo.ts):
 *   import { runInkRepl } from '../src/ui/ink/runInkRepl.js'
 *   await runInkRepl({ config, version, model, ... })
 */

import { render } from 'ink'
import { createElement } from 'react'
import { UIStore } from './store.js'
import { InkRenderer } from './inkRenderer.js'
import { App } from './App.js'
import type { Renderer } from '../renderer.js'
import { ExecutionEngine } from '../../core/engine.js'
import type { OpenAIMessage } from '../../core/types.js'
import type { OpenAI } from 'openai'
import { dispatchSlashCommand, type SlashCommandContext } from '../../commands/index.js'
import { listSessions } from '../../core/sessionManager.js'

export interface InkReplOptions {
  config: ConstructorParameters<typeof ExecutionEngine>[0]
  version: string
  model: string
  skills: Array<{ name: string; description: string }>
  client?: OpenAI
  sessionDir?: string
  cwd: string
  resumedHistory?: OpenAIMessage[]
  maxContextTokens: number
}

export async function runInkRepl(opts: InkReplOptions): Promise<void> {
  const store = new UIStore()
  const inkRenderer = new InkRenderer(store)

  // Cast: InkRenderer has all public methods of Renderer but is not a subclass.
  // The engine only calls methods — never accesses Renderer's private fields.
  const engine = new ExecutionEngine(
    opts.config,
    inkRenderer as unknown as Renderer,
    opts.client,
  )

  // ── Slash command context ─────────────────────────────────────────────────
  let history: OpenAIMessage[] = opts.resumedHistory ? [...opts.resumedHistory] : []

  const slashCtx: SlashCommandContext = {
    engine,
    renderer: inkRenderer as unknown as Renderer,
    history,
    cwd: opts.cwd,
    sessionDir: opts.sessionDir,
    setHistory: (msgs: OpenAIMessage[]) => {
      history.length = 0
      history.push(...msgs)
      store.clearMessages()
    },
    runPrompt: (prompt: string) => {
      // Defer to the App's turn execution — but since runPrompt is synchronous
      // in the slash context, we fire-and-forget the turn.
      void runOneTurn(prompt)
    },
    getSkillsText: () => {
      if (opts.skills.length === 0) return 'No skills available.'
      return opts.skills.map((s) => `/${s.name.padEnd(16)} ${s.description}`).join('\n')
    },
    getSessionsText: () => {
      const sessions = listSessions(opts.cwd)
      if (sessions.length === 0) return 'No saved sessions found.'
      return sessions
        .slice(0, 10)
        .map((s) => `  ${s.name}  ${s.messages} msgs`)
        .join('\n')
    },
  }

  // ── Turn execution ────────────────────────────────────────────────────────

  async function runOneTurn(prompt: string): Promise<{ newHistory: OpenAIMessage[]; reason: string }> {
    store.setRunning(true)
    store.setSpinner(true, 'Thinking')
    try {
      const result = await engine.runTurn(prompt, history)
      history = result.newHistory
      return { newHistory: result.newHistory, reason: result.result.reason }
    } catch (err: unknown) {
      const error = err as Error
      if (error.name !== 'AbortError') {
        store.addError(`Error: ${error.message}`)
      }
      return { newHistory: history, reason: 'error' }
    } finally {
      store.setRunning(false)
      store.setSpinner(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const instance = render(
    createElement(App, {
      store,
      _version: opts.version,
      model: opts.model,
      skills: opts.skills,
      runTurn: async (prompt: string, currentHistory: OpenAIMessage[]) => {
        history = currentHistory
        return runOneTurn(prompt)
      },
      dispatchSlash: async (input: string): Promise<boolean> => {
        const result = await dispatchSlashCommand(input, slashCtx)
        if (result === null) return false
        switch (result.type) {
          case 'text':
            store.addInfo(result.value)
            return true
          case 'exit':
            instance.unmount()
            return true
          case 'prompt':
            // Run the resolved prompt as a turn
            void runOneTurn(result.value)
            return true
          case 'clear-history':
            history.length = 0
            store.clearMessages()
            return true
          case 'noop':
            return true
        }
        return true
      },
      initialHistory: history,
      maxContextTokens: opts.maxContextTokens,
    }),
  )

  // Set banner
  store.setBanner(opts.version, opts.model)

  await instance.waitUntilExit()
  inkRenderer.destroy()
}
