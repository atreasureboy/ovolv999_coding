import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { analyzeFile } from '../../src/core/codeMetrics.js'
import { detectFileReferences } from '../../src/core/fileDetection.js'
import { extractDocs } from '../../src/core/magicDocs.js'
import { analyzeProject, formatOverview } from '../../src/core/onboarding.js'
import { matchHook } from '../../src/core/hooks.js'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'source-analysis-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('source analysis boundaries', () => {
  it('analyzes files with more lines than the JavaScript argument limit', () => {
    const path = join(root, 'large.ts')
    writeFileSync(path, 'x\n'.repeat(200_000))
    expect(analyzeFile(path)).toMatchObject({ totalLines: 200_001, longestLine: 1 })
  })

  it.each(['"""', "'''"])('counts Python multiline docstrings ending in %s', delimiter => {
    const path = join(root, 'module.py')
    writeFileSync(path, [delimiter, 'module documentation', delimiter, 'x = 1'].join('\n'))
    expect(analyzeFile(path)).toMatchObject({ commentLines: 3, codeLines: 1 })
  })

  it('retains a native absolute path and its line range', () => {
    const path = join(root, 'source.ts')
    writeFileSync(path, 'first\nsecond\nthird')
    const refs = detectFileReferences(`Read ${path}:2-3`, { cwd: root, searchBareNames: false })
    expect(refs).toEqual([expect.objectContaining({ raw: `${path}:2-3`, path, lineStart: 2, lineEnd: 3 })])
  })

  it('finds tracked bare names inside Unicode directories without git quoting corruption', () => {
    mkdirSync(join(root, '日本語'))
    const path = join(root, '日本語', 'unique.ts')
    writeFileSync(path, 'export const value = 1')
    execFileSync('git', ['init', root], { stdio: 'pipe' })
    execFileSync('git', ['add', '--', '日本語/unique.ts'], { cwd: root, stdio: 'pipe' })
    expect(detectFileReferences('Read unique.ts', { cwd: root })).toEqual([expect.objectContaining({ raw: 'unique.ts', path })])
  })

  it('counts every route once even when several endpoints share a line', () => {
    writeFileSync(join(root, 'server.ts'), "app.get('/one', handler); app.get('/two', handler)")
    const section = extractDocs({ rootDir: root, sections: ['api'] }).sections[0]
    expect(section.content).toContain('Found 2 API endpoint(s)')
    expect(section.content.match(/`\/one`/g)).toHaveLength(1)
    expect(section.content.match(/`\/two`/g)).toHaveLength(1)
  })

  it('extracts the advertised tests section from suites and test cases', () => {
    writeFileSync(join(root, 'feature.test.ts'), "describe('feature area', () => { it('works correctly', () => {}) })")
    const result = extractDocs({ rootDir: root, sections: ['tests'] })
    expect(result.sections).toHaveLength(1)
    expect(result.sections[0].type).toBe('tests')
    expect(result.sections[0].content).toContain('feature area')
    expect(result.sections[0].content).toContain('works correctly')
  })

  it('detects Next.js and Prettier and does not claim unchecked strict typing', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { next: '15', react: '19' }, devDependencies: { prettier: '3' } }))
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: false } }))
    const overview = analyzeProject(root)
    expect(overview.framework).toBe('Next.js')
    expect(overview.conventions).toContain('Prettier formatting')
    expect(overview.conventions).not.toContain('TypeScript strict typing')
  })

  it('formats nested project directories once', () => {
    mkdirSync(join(root, 'src', 'nested'), { recursive: true })
    writeFileSync(join(root, 'src', 'nested', 'index.ts'), 'export {}')
    const text = formatOverview(analyzeProject(root))
    expect(text.match(/src\//g)).toHaveLength(1)
  })

  it('matches the actual file_path field used by file tools', () => {
    expect(matchHook('Write(src/*)', 'Write', { file_path: 'src/feature.ts' })).toBe(true)
  })
})
