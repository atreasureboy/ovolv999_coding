import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mergeAllConfigs, validateConfig } from '../../src/core/config.js'
import { createProfile, getProfile, getEffectiveConfig, loadProfiles } from '../../src/core/profiles.js'
import { addBookmark, loadBookmarks, removeBookmark } from '../../src/core/bookmarks.js'
import { addSnippet, fillSnippet, getSnippetStats, loadSnippets } from '../../src/core/snippets.js'
import { addEntry, getUniqueTexts, loadHistory, searchHistory } from '../../src/core/commandHistory.js'
import { loadCustomModes, resetModeCache } from '../../src/core/modes.js'

let cwd: string
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'ovogo-persisted-audit-'))
  resetModeCache()
})
afterEach(() => {
  resetModeCache()
  vi.unstubAllEnvs()
  rmSync(cwd, { recursive: true, force: true })
})

function writeStore(name: string, value: unknown): void {
  mkdirSync(join(cwd, '.ovolv999'), { recursive: true })
  writeFileSync(join(cwd, '.ovolv999', name), JSON.stringify(value))
}

describe('persisted utility audit', () => {
  it('keeps global preferences when the project file is absent or only overrides one field', () => {
    const home = join(cwd, 'home')
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    mkdirSync(join(home, '.ovolv999'), { recursive: true })
    writeFileSync(join(home, '.ovolv999', 'settings.json'), JSON.stringify({
      provider: { name: 'custom', model: 'my-model' }, ui: { showCost: true },
    }))
    expect(mergeAllConfigs(cwd).provider.name).toBe('custom')
    writeStore('settings.json', { ui: { theme: 'dark' } })
    const result = mergeAllConfigs(cwd)
    expect(result.provider).toEqual({ name: 'custom', model: 'my-model' })
    expect(result.ui.showCost).toBe(true)
    expect(result.ui.theme).toBe('dark')
  })

  it.each([[], { model: { temperature: NaN } }, { model: { maxTokens: Infinity } },
    { model: { contextWindow: 1.5 } }, { ui: { showCost: 'yes' } },
    { behavior: { memoryExtract: 'yes' } }, { env: { TOKEN: 123 } },
    { permissions: { rules: [{}] } }, { permissions: { rules: [{ pattern: '*', tool: 'Bash', decision: { toString: 0 } }] } }, { provider: false }])('rejects malformed configuration %j', value => {
    expect(validateConfig(value).valid).toBe(false)
  })

  it.each([null, [], { bookmarks: null }, { bookmarks: [null] }])('ignores malformed bookmark data %j', value => {
    writeStore('bookmarks.json', value)
    expect(loadBookmarks(cwd).bookmarks).toEqual([])
    expect(() => addBookmark(cwd, 'a.ts', 1, 'target')).not.toThrow()
  })

  it('retains healthy rows and refuses to delete bookmarks with an empty selector', () => {
    const bookmark = addBookmark(cwd, 'a.ts', 1, 'target')
    writeStore('bookmarks.json', { bookmarks: [null, bookmark, { note: 12 }] })
    expect(loadBookmarks(cwd).bookmarks).toEqual([bookmark])
    expect(removeBookmark(cwd, '')).toBe(false)
    expect(loadBookmarks(cwd).bookmarks).toEqual([bookmark])
  })

  it.each([null, [], { snippets: null }, { snippets: [null] }])('ignores malformed snippet data %j', value => {
    writeStore('snippets.json', value)
    expect(loadSnippets(cwd).snippets).toEqual([])
    expect(() => addSnippet(cwd, { name: 'valid', body: 'hello', language: 'text' })).not.toThrow()
  })

  it('treats prototype names as ordinary snippet variables and statistic keys', () => {
    expect(fillSnippet('{{constructor}} {{toString}} {{__proto__}}', {}))
      .toBe('{{constructor}} {{toString}} {{__proto__}}')
    addSnippet(cwd, { name: 'safe', body: 'text', language: 'constructor', category: '__proto__', tags: ['toString'] })
    const stats = getSnippetStats(cwd)
    expect(stats.byLanguage).toMatchObject({ constructor: 1 })
    expect(stats.byCategory['__proto__']).toBe(1)
    expect(stats.byTag).toMatchObject({ toString: 1 })
  })

  it('retains healthy history beside enum data with a shadowed toString', () => {
    const path = join(cwd, '.ovolv999', 'history.json')
    const row = addEntry(path, 'hello', 'prompt', cwd)
    writeStore('history.json', { entries: [row, { ...row, id: 'broken', type: { toString: 0 } }] })
    expect(loadHistory(path).entries).toEqual([row])
  })

  it.each([null, [], { profiles: null }, { profiles: { broken: null } }])('ignores malformed profile data %j', value => {
    writeStore('profiles.json', value)
    expect(Object.keys(loadProfiles(cwd).profiles)).toEqual([])
    expect(() => createProfile(cwd, 'valid')).not.toThrow()
  })

  it('does not return object prototype members as profiles and persists a prototype-named profile', () => {
    expect(getProfile(cwd, 'constructor')).toBeNull()
    const created = createProfile(cwd, '__proto__')
    expect(getProfile(cwd, '__proto__')).toEqual(created)
    expect(Object.keys(loadProfiles(cwd).profiles)).toEqual(['__proto__'])
  })

  it('isolates effective default objects between callers', () => {
    const first = getEffectiveConfig(cwd)
    first.provider.name = 'mutated'
    first.env['LEAK'] = 'mutated'
    const second = getEffectiveConfig(cwd)
    expect(second.provider.name).toBe('openai')
    expect(second.env).toEqual({})
  })

  it('drops malformed history rows while preserving valid entries', () => {
    const file = join(cwd, 'history.json')
    const entry = addEntry(file, 'hello', 'prompt', cwd)
    writeFileSync(file, JSON.stringify({ entries: [null, entry, { text: 42 }] }))
    expect(loadHistory(file).entries).toEqual([entry])
  })

  it('returns no history suggestions for a zero limit, including empty queries', () => {
    const store = { entries: [addEntry(join(cwd, 'history.json'), 'hello', 'prompt', cwd)] }
    expect(searchHistory(store, '', { limit: 0 })).toEqual([])
    expect(getUniqueTexts(store, '', 0)).toEqual([])
  })

  it('loads Windows frontmatter and keeps distinct mode directories isolated', () => {
    const first = join(cwd, 'one')
    const second = join(cwd, 'two')
    mkdirSync(first); mkdirSync(second)
    writeFileSync(join(first, 'one.md'), '---\r\nname: First\r\nslug: first\r\n---\r\nfirst body')
    writeFileSync(join(second, 'two.md'), '---\nname: Second\nslug: second\n---\nsecond body')
    expect(loadCustomModes(first).map(mode => mode.slug)).toEqual(['first'])
    expect(loadCustomModes(second).map(mode => mode.slug)).toEqual(['second'])
  })
})
