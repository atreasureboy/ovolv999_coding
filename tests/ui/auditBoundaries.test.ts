import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseGitDiff } from '../../src/ui/diffBrowser.js'
import { renderMarkdown } from '../../src/ui/markdown.js'
import { stripAnsi } from '../../src/utils/ansi.js'
import { createVimState, handleVimKey } from '../../src/ui/vim.js'
import { Renderer } from '../../src/ui/renderer.js'
import { runWithDeadline } from '../../src/ui/turnDeadline.js'
import { UIStore } from '../../src/ui/ink/store.js'
import { InkRenderer } from '../../src/ui/ink/inkRenderer.js'
import { SlashSuggester } from '../../src/ui/slashSuggest.js'
import { colorizeUltrathink, truncate as truncateThinking } from '../../src/ui/thinkingDisplay.js'
import { renderStatusLine } from '../../src/ui/statusLine.js'

afterEach(() => vi.useRealTimers())

describe('UI audit boundaries', () => {
  it('preserves overlapping thinking triggers and very short previews', () => {
    expect(stripAnsi(colorizeUltrathink('Please think harder about this'))).toBe('Please think harder about this')
    expect(truncateThinking('long preview', 3)).toBe('...')
    expect(truncateThinking('long preview', 0)).toBe('')
  })

  it('fits a status segment inside a terminal width smaller than four characters', () => {
    expect(stripAnsi(renderStatusLine({ model: 'long-model' }, { segments: [{ id: 'model', render: data => data.model ?? '', priority: 1 }], separator: ' | ', maxWidth: 1 })).length).toBeLessThanOrEqual(1)
  })
  it('keeps each file hunk and header-like source lines in the correct file', () => {
    const diff = parseGitDiff('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n--- old\n+++ new\ndiff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-before\n+after\n')
    expect(diff.files.map((file) => [file.newPath, file.hunks.length, file.additions, file.deletions])).toEqual([['a.ts', 1, 1, 1], ['b.ts', 1, 1, 1]])
    expect(diff.files[0].hunks[0].lines.map((line) => line.content)).toEqual(['-- old', '++ new'])
  })

  it('renders syntax colors without coloring its own ANSI escapes', () => {
    expect(stripAnsi(renderMarkdown('```ts\nconst count = 42\nconst message = "return 123"\n```'))).toBe('const count = 42\nconst message = "return 123"')
  })

  it('yanks complete lines without changing the text', () => {
    let state = { ...createVimState('normal'), text: 'first\nsecond', cursor: 0 }
    state = handleVimKey(state, 'y').state
    const result = handleVimKey(state, 'y').state
    expect(result.text).toBe('first\nsecond')
    expect(result.register).toBe('first\n')
    expect(result.cursor).toBe(0)
  })

  it('keeps an empty normal-mode cursor in bounds', () => {
    expect(handleVimKey(createVimState('normal'), 'l').state.cursor).toBe(0)
  })

  it('advances insertion by the length of a paste', () => {
    expect(handleVimKey(createVimState(), 'hello').state).toMatchObject({ text: 'hello', cursor: 5 })
  })

  it('stops its spinner and detaches resize without closing a borrowed stream', () => {
    vi.useFakeTimers()
    const stream = Object.assign(new PassThrough(), { isTTY: true, columns: 80 })
    stream.resume()
    const renderer = new Renderer({ stream })
    renderer.startSpinner()
    renderer.destroy()
    expect(stream.writableEnded).toBe(false)
    expect(stream.listenerCount('resize')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    stream.end()
  })

  it('captures a task throwing synchronously in its deadline handle', async () => {
    const error = new Error('sync task failure')
    const handle = runWithDeadline(() => { throw error }, { deadlineMs: 100, onDeadline: () => {} })
    try {
      await expect(handle.promise).rejects.toBe(error)
      expect(await handle.taskSettled).toEqual({ status: 'rejected', reason: error })
    } finally { handle.clear() }
  })

  it('matches out-of-order tool and agent completion to their names', () => {
    const store = new UIStore()
    const renderer = new InkRenderer(store)
    renderer.toolStart('Read', { file_path: 'a' })
    renderer.toolStart('Bash', { command: 'echo b' })
    renderer.toolResult('Read', 'file a', false)
    renderer.toolResult('Bash', 'b', false)
    renderer.agentStart('first', 'explore')
    renderer.agentStart('second', 'general')
    renderer.agentDone('first', true)
    renderer.agentDone('second', false)
    renderer.agentSummary('explore', 'first', 'first summary')
    expect(store.getState().messages).toMatchObject([{ name: 'Read', result: 'file a' }, { name: 'Bash', result: 'b' }, { desc: 'first', status: 'done', summary: 'first summary' }, { desc: 'second', status: 'failed' }])
  })

  it('does not redraw a queued slash suggestion after detaching', async () => {
    const chunks: string[] = []
    const stream = new PassThrough()
    stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString()))
    const suggester = new SlashSuggester({ source: { isTTY: true, getCommands: () => [{ name: 'help', description: 'Help' }], getSkills: () => [] }, stream, getLine: () => '/h' })
    suggester.attach()
    process.stdin.emit('keypress', 'h', { name: 'h' })
    suggester.detach()
    chunks.length = 0
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(chunks).toEqual([])
    stream.end()
  })
})
