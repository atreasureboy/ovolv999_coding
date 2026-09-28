import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverFiles, extractDocs } from '../src/core/magicDocs.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('portable documentation discovery', () => {
  it('supports directory globs, spaces, excluded subtrees, and absolute file reads', () => {
    const root = mkdtempSync(join(tmpdir(), 'magic docs 中文-'))
    roots.push(root)
    mkdirSync(join(root, 'src', 'node_modules'), { recursive: true })
    mkdirSync(join(root, 'dist'))
    writeFileSync(join(root, 'src', 'route.ts'), "app.get('/portable', () => {})")
    writeFileSync(join(root, 'src', 'route.js'), "app.get('/javascript', () => {})")
    writeFileSync(join(root, 'src', 'node_modules', 'hidden.ts'), "app.get('/secret', () => {})")
    writeFileSync(join(root, 'dist', 'hidden.ts'), "app.get('/generated', () => {})")
    expect(discoverFiles(root, ['src/*.{ts,js}', '**/*.ts']).map(path => path.replaceAll('\\', '/'))).toEqual([
      join(root, 'src', 'route.js').replaceAll('\\', '/'),
      join(root, 'src', 'route.ts').replaceAll('\\', '/'),
    ])
    const result = extractDocs({ rootDir: root, sections: ['api'] })
    expect(result.fileCount).toBe(2)
    expect(result.sections[0].content).toContain('/portable')
    expect(result.sections[0].content).not.toContain('/secret')
    expect(discoverFiles(root, undefined, 0)).toEqual([])
    expect(discoverFiles(root, undefined, 1)).toHaveLength(1)
  })
})
