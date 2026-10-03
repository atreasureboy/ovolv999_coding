import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeProject } from '../../src/core/onboarding.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('project statistics file budget', () => {
  it.each(['flat', 'nested'])('stops at 500 source files in a %s project', layout => {
    const root = mkdtempSync(join(tmpdir(), 'onboarding-budget-'))
    roots.push(root)
    const source = layout === 'nested' ? join(root, 'a-source') : root
    mkdirSync(source, { recursive: true })
    for (let index = 0; index < 500; index++) {
      writeFileSync(join(source, `${String(index).padStart(3, '0')}.ts`), 'export const value = 1\n')
    }
    writeFileSync(join(root, 'z-extra.ts'), 'export const excluded = 2\n'.repeat(50))

    const { stats } = analyzeProject(root)

    expect(stats.totalFiles).toBe(500)
    expect(stats.totalLines).toBe(1000)
    expect(stats.filesByExtension).toEqual({ '.ts': 500 })
    expect(stats.linesByExtension).toEqual({ '.ts': 1000 })
    expect(stats.largestFiles).toHaveLength(10)
    expect(stats.largestFiles.every(file => file.lines === 2)).toBe(true)
  })
})
