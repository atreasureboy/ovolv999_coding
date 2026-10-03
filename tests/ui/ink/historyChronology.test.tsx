import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, render } from 'ink-testing-library'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from '../../../src/ui/ink/App.js'
import { UIStore } from '../../../src/ui/ink/store.js'
import { saveInputHistory } from '../../../src/utils/inputHistory.js'
let directory: string | undefined
afterEach(() => { cleanup(); vi.unstubAllEnvs(); if (directory) rmSync(directory, { recursive: true, force: true }) })
describe('persisted input chronology', () => {
  it('recalls the latest persisted prompt on the first Up key', async () => {
    directory = mkdtempSync(join(tmpdir(), 'ovogo-input-chronology-'))
    vi.stubEnv('HOME', directory); vi.stubEnv('USERPROFILE', directory)
    saveInputHistory('older prompt'); saveInputHistory('latest prompt')
    const view = render(createElement(App, { store: new UIStore(), _version: 'test', model: 'test', skills: [], initialHistory: [], maxContextTokens: 100, cwd: directory, runTurn: () => Promise.resolve({ newHistory: [], reason: 'stop' }), dispatchSlash: () => Promise.resolve(false) }))
    await vi.waitFor(() => expect(view.stdin.listenerCount('readable')).toBeGreaterThan(0))
    view.stdin.write('\x1b[A')
    await vi.waitFor(() => expect(view.lastFrame()).toContain('latest prompt'))
  })
})
