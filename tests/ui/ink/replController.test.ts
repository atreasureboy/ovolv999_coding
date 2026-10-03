import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ExecutionEngine } from '../../../src/core/engine.js'
import type { OpenAIMessage, TurnResult } from '../../../src/core/types.js'
import type { Renderer } from '../../../src/ui/renderer.js'
import {
  createSessionDir,
  loadSession,
  releaseSessionOwnership,
  saveSession,
} from '../../../src/core/sessionManager.js'
import { createInkReplController } from '../../../src/ui/ink/replController.js'
import { UIStore } from '../../../src/ui/ink/store.js'
import '../../../src/commands/builtin.js'

describe('Ink REPL controller', () => {
  let directory: string
  let sessionDir: string
  let sessionDirs: string[]
  let store: UIStore
  let model: string
  let result: TurnResult
  let failure: Error | undefined
  let exits: number

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ovogo-ink-controller-'))
    sessionDir = createSessionDir(directory)
    sessionDirs = [sessionDir]
    store = new UIStore()
    store.setBanner('test', 'glm-4.6')
    model = 'glm-4.6'
    result = { stopped: true, reason: 'stop_sequence', output: 'Answer' }
    failure = undefined
    exits = 0
  })

  afterEach(() => {
    for (const path of sessionDirs) releaseSessionOwnership(path)
    rmSync(directory, { recursive: true, force: true })
  })

  function controller(overrides: { sessionDir?: string; resumedHistory?: OpenAIMessage[] } = {}) {
    const engine = {
      runTurn: (prompt: string, history: OpenAIMessage[]) => {
        if (failure) return Promise.reject(failure)
        return Promise.resolve({
          newHistory: [
            ...history,
            { role: 'user', content: prompt },
            { role: 'assistant', content: 'Answer' },
          ],
          result,
        })
      },
      getCostTracker: () => ({ getTotalCost: () => 1.25, getTotalAPICalls: () => 3 }),
      getModel: () => model,
      setModel: (value: string) => {
        model = value
      },
    } as unknown as ExecutionEngine
    return createInkReplController({
      store,
      engine,
      inkRenderer: {} as Renderer,
      skills: [],
      cwd: directory,
      sessionDir,
      onExit: () => {
        exits++
      },
      ...overrides,
    })
  }

  it('saves completed turns and updates visible cost and activity', async () => {
    const repl = controller()
    const pending = repl.runTurn('Question')
    expect(store.getState()).toMatchObject({ running: true, spinnerActive: true })
    const completed = await pending
    expect(completed.status).toBe('completed')
    expect(loadSession(sessionDir)).toEqual([
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: 'Answer' },
    ])
    expect(store.getState()).toMatchObject({
      running: false,
      spinnerActive: false,
      cost: 1.25,
      apiCalls: 3,
    })
  })

  it('reports verification failures while retaining the returned history', async () => {
    result.status = 'failed'
    result.verification = {
      status: 'failed',
      workspace: directory,
      commands: [],
      output: 'Build failed',
    }
    const completed = await controller().runTurn('Question')
    expect(completed.status).toBe('failed')
    expect(completed.newHistory).toHaveLength(2)
    expect(store.getState().messages).toContainEqual({
      id: 1,
      type: 'error',
      text: 'Task failed: Build failed',
    })
  })

  it('formats API failures and stops the spinner', async () => {
    failure = new Error('HTTP 429')
    const completed = await controller().runTurn('Question')
    expect(completed).toMatchObject({ reason: 'error', newHistory: [] })
    expect(store.getState()).toMatchObject({ running: false, spinnerActive: false })
    expect(store.getState().messages[0]).toMatchObject({
      type: 'error',
      text: expect.stringContaining('Rate limited'),
    })
  })

  it('quietly settles an aborted turn', async () => {
    failure = new Error('cancelled')
    failure.name = 'AbortError'
    const completed = await controller().runTurn('Question')
    expect(completed.reason).toBe('error')
    expect(store.getState()).toMatchObject({ running: false, spinnerActive: false, messages: [] })
  })

  it('completes a turn when the best-effort session save cannot write', async () => {
    const occupiedPath = join(directory, 'occupied')
    writeFileSync(occupiedPath, 'file')
    const completed = await controller({ sessionDir: occupiedPath }).runTurn('Question')
    expect(completed.status).toBe('completed')
    expect(completed.newHistory).toHaveLength(2)
  })

  it('changes the active model through the picker and its slash alias', async () => {
    const repl = controller()
    const pending = repl.dispatchSlash('/model')
    expect(store.getState().selectOverlay?.title).toBe('Switch Model')
    store.resolveSelect('gpt-4o')
    await pending
    expect(store.getState().banner?.model).toBe('gpt-4o')
    await repl.dispatchSlash('/m')
    expect(store.getState().messages.at(-1)).toMatchObject({
      type: 'info',
      text: 'Current model: gpt-4o',
    })
  })

  it('resumes a saved conversation through the picker', async () => {
    saveSession(sessionDir, [{ role: 'user', content: 'Saved question' }])
    const repl = controller()
    const pending = repl.dispatchSlash('/resume')
    expect(store.getState().selectOverlay?.items[0].value).toBe(basename(sessionDir))
    store.resolveSelect(basename(sessionDir))
    await pending
    await repl.dispatchSlash('/history')
    expect(store.getState().messages.at(-1)).toMatchObject({
      type: 'info',
      text: expect.stringContaining('Saved question'),
    })
  })

  it('returns the existing not-found result for an unresolved session name', async () => {
    await expect(controller().dispatchSlash('/resume missing-session')).resolves.toBe(true)
    expect(store.getState().messages.at(-1)).toMatchObject({
      type: 'info',
      text: expect.stringContaining('Session not found'),
    })
  })

  function savedSession(messages: OpenAIMessage[]): string {
    const path = createSessionDir(directory)
    sessionDirs.push(path)
    saveSession(path, messages)
    releaseSessionOwnership(path)
    return path
  }

  it('writes resumed turns to the selected session and releases the old writer', async () => {
    const original: OpenAIMessage[] = [{ role: 'user', content: 'Original question' }]
    saveSession(sessionDir, original)
    const selected = savedSession([{ role: 'user', content: 'Resumed question' }])
    const repl = controller({ resumedHistory: original })
    await repl.dispatchSlash(`/resume ${basename(selected)}`)
    await repl.runTurn('Follow-up')
    expect(loadSession(selected)).toEqual([
      { role: 'user', content: 'Resumed question' },
      { role: 'user', content: 'Follow-up' },
      { role: 'assistant', content: 'Answer' },
    ])
    expect(loadSession(sessionDir)).toEqual(original)
    expect(readdirSync(join(sessionDir, 'writer.lock.owners'))).toEqual([])
  })

  it('releases the resumed session writer on cleanup', async () => {
    const selected = savedSession([{ role: 'user', content: 'Resumed question' }])
    const repl = controller()
    await repl.dispatchSlash(`/resume ${basename(selected)}`)
    expect(readdirSync(join(selected, 'writer.lock.owners'))).not.toEqual([])
    repl.release()
    expect(readdirSync(join(selected, 'writer.lock.owners'))).toEqual([])
  })

  it('persists a cleared conversation immediately', async () => {
    const original: OpenAIMessage[] = [{ role: 'user', content: 'Original question' }]
    saveSession(sessionDir, original)
    const repl = controller({ resumedHistory: original })
    await repl.dispatchSlash('/clear')
    expect(repl.getHistory()).toEqual([])
    expect(loadSession(sessionDir)).toEqual([])
  })

  it('keeps the current history and save target when a resumed session is corrupt', async () => {
    const original: OpenAIMessage[] = [{ role: 'user', content: 'Original question' }]
    saveSession(sessionDir, original)
    const selected = savedSession([{ role: 'user', content: 'Saved question' }])
    writeFileSync(join(selected, 'history.json'), '{broken')
    const repl = controller({ resumedHistory: original })
    await repl.dispatchSlash(`/resume ${basename(selected)}`)
    expect(repl.getHistory()).toEqual(original)
    await repl.runTurn('Follow-up')
    expect(loadSession(sessionDir).at(-2)).toMatchObject({ content: 'Follow-up' })
    expect(readdirSync(join(selected, 'writer.lock.owners'))).toEqual([])
  })

  it('keeps the current session when another writer owns the selected session', async () => {
    const original: OpenAIMessage[] = [{ role: 'user', content: 'Original question' }]
    saveSession(sessionDir, original)
    const selected = savedSession([{ role: 'user', content: 'Other conversation' }])
    writeFileSync(join(selected, 'writer.lock'), JSON.stringify({ pid: process.pid }))
    const repl = controller({ resumedHistory: original })
    await repl.dispatchSlash(`/resume ${basename(selected)}`)
    expect(repl.getHistory()).toEqual(original)
    await repl.runTurn('Follow-up')
    expect(loadSession(selected)).toEqual([{ role: 'user', content: 'Other conversation' }])
    expect(loadSession(sessionDir).at(-2)).toMatchObject({ content: 'Follow-up' })
  })

  it('resumes an empty saved conversation through the picker and saves its next turn', async () => {
    const selected = savedSession([])
    const repl = controller({ resumedHistory: [{ role: 'user', content: 'Old question' }] })
    const pending = repl.dispatchSlash('/resume')
    store.resolveSelect(basename(selected))
    await pending
    expect(repl.getHistory()).toEqual([])
    await repl.runTurn('First question')
    expect(loadSession(selected)).toEqual([
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'Answer' },
    ])
  })

  it('routes exit commands and preserves unknown-command fallback', async () => {
    const repl = controller()
    await expect(repl.dispatchSlash('/not-a-command')).resolves.toBe(false)
    await expect(repl.dispatchSlash('/q')).resolves.toBe(true)
    expect(exits).toBe(1)
  })
})
