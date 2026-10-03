import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatApiError } from '../../src/utils/apiError.js'
import { openInEditor } from '../../src/utils/editor.js'
import { getSecret, getVaultFilePath, setSecret } from '../../src/utils/keychain.js'
import { withVCR } from '../../src/utils/vcr.js'
import { suggestFiles } from '../../src/ui/ink/fileSuggest.js'
import { expandAtMentions } from '../../src/ui/ink/expandAtMentions.js'
import { globMatch } from '../../src/utils/globMatch.js'
import { maskSecrets } from '../../src/utils/secretScanner.js'
import { getCurrentVersion, compareVersions } from '../../src/utils/autoUpdater.js'
import { truncate } from '../../src/utils/ansi.js'

describe('file audit boundaries', () => {
  let directory: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ovogo-audit-boundaries-'))
    vi.stubEnv('HOME', directory)
    vi.stubEnv('USERPROFILE', directory)
    vi.stubEnv('PATH', '')
    vi.stubEnv('VISUAL', 'missing-audit-editor')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(directory, { recursive: true, force: true })
  })

  it.each([null, undefined, { message: 42 }])('formats unusual thrown values without a secondary crash: %s', (error) => {
    expect(formatApiError(error).title).toBe('Error')
  })

  it('removes the editor temporary directory after a launch failure', () => {
    const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith('ovolv999-edit-')))
    expect(openInEditor('Draft')).toBeNull()
    const leaked = readdirSync(tmpdir()).filter((name) => name.startsWith('ovolv999-edit-') && !before.has(name))
    try {
      expect(leaked).toEqual([])
    } finally {
      for (const name of leaked) rmSync(join(tmpdir(), name), { recursive: true, force: true })
    }
  })

  it('launches quoted editor commands with arguments and returns the edited file', () => {
    const helper = join(directory, 'editor fixture.cjs')
    writeFileSync(helper, "require('node:fs').writeFileSync(process.argv.at(-1), 'edited prompt')")
    vi.stubEnv('VISUAL', `"${process.execPath}" "${helper}" --wait`)
    expect(openInEditor('draft')).toBe('edited prompt')
  })

  it('keeps an existing encrypted vault intact when the mutation passphrase is wrong', () => {
    setSecret('original', 'kept-value', 'correct-passphrase')
    const original = readFileSync(getVaultFilePath(), 'utf8')
    expect(() => setSecret('new', 'lost-value', 'incorrect-passphrase')).toThrow()
    expect(readFileSync(getVaultFilePath(), 'utf8')).toBe(original)
    expect(getSecret('original', 'correct-passphrase')).toBe('kept-value')
  })

  it('applies VCR helper overrides without discarding default configuration', async () => {
    await withVCR(async (vcr) => {
      const params = { prompt: 'Record fixture' }
      const result = await vcr.intercept({ create: () => Promise.resolve('Recorded response') }, 'create', params)
      expect(result).toBe('Recorded response')
      const fixture = vcr.fixturePath('create', params)
      expect(existsSync(fixture)).toBe(true)
      expect(fixture).toContain('vcr_create_')
    }, { mode: 'record', fixtureDir: directory })()
  })

  it('lists children when completing a directory path with a trailing separator', () => {
    mkdirSync(join(directory, 'src'))
    writeFileSync(join(directory, 'src', 'child.ts'), 'Content')
    expect(suggestFiles(directory, 'src/')).toContainEqual({ path: 'src/child.ts', label: 'child.ts', isDir: false })
  })

  it('expands filenames offered by autocomplete that contain non-ASCII letters', () => {
    writeFileSync(join(directory, '说明.ts'), 'Unicode file')
    const expanded = expandAtMentions('Read @说明.ts', directory)
    expect(expanded.mentions).toEqual([{ path: '说明.ts', found: true, truncated: false, chars: 12, isImage: false }])
    expect(expanded.text).toContain('Unicode file')
  })

  it('matches directory globstars without treating them as filename prefixes', () => {
    expect(globMatch('src/**/test.ts', 'src/test.ts')).toBe(true)
    expect(globMatch('src/**/test.ts', 'src/deep/test.ts')).toBe(true)
    expect(globMatch('src/**/test.ts', 'src/mytest.ts')).toBe(false)
  })

  it('masks project key prefixes including separators in the complete key', () => {
    const secret = 'sk-proj-' + 'A1b2_C3d4-'.repeat(6)
    expect(maskSecrets(secret).found).toBe(true)
    expect(maskSecrets(secret).masked).not.toContain('C3d4-A1b2')
  })

  it('reads its own package version regardless of the current project', () => {
    const ownVersion = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'unrelated', version: '999.0.0' }))
    const cwd = process.cwd()
    try { process.chdir(directory); expect(getCurrentVersion()).toBe(ownVersion) }
    finally { process.chdir(cwd) }
  })

  it('compares prerelease numeric identifiers numerically', () => {
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.2')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-2', '1.0.0-beta')).toBeLessThan(0)
  })

  it('limits truncation at zero and narrower than the suffix', () => {
    expect(truncate('long text', 0)).toBe('')
    expect(truncate('long text', 1, '...')).toBe('.')
  })

  it('recovers malformed cache storage and treats model names as own keys', async () => {
    mkdirSync(join(directory, '.ovolv999'))
    writeFileSync(join(directory, '.ovolv999', 'cache-stats.json'), JSON.stringify({ entries: [] }))
    vi.resetModules()
    const cache = await import('../../src/utils/cacheStats.js')
    cache.recordCacheEntry('__proto__', true, { inputTokens: 10, outputTokens: 5 })
    cache.recordCacheEntry('constructor', false, { inputTokens: 10, outputTokens: 5 })
    expect(cache.getCacheStats().byModel).toMatchObject({ ['__proto__']: { requests: 1, hits: 1 }, constructor: { requests: 1, misses: 1 } })
  })
})
