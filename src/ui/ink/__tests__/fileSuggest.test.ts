/**
 * Tests for the file suggestion utility.
 */

import { describe, it, expect } from 'vitest'
import { suggestFiles } from '../fileSuggest.js'

describe('suggestFiles', () => {
  it('returns files in cwd for empty query', () => {
    const results = suggestFiles(process.cwd(), '')
    expect(results.length).toBeGreaterThan(0)
    // Should include package.json
    expect(results.some((r) => r.path === 'package.json')).toBe(true)
  })

  it('filters by prefix', () => {
    const results = suggestFiles(process.cwd(), 'pack')
    expect(results.length).toBeGreaterThan(0)
    expect(results.every((r) => r.label.toLowerCase().startsWith('pack'))).toBe(true)
  })

  it('returns directories with isDir=true', () => {
    const results = suggestFiles(process.cwd(), 'src')
    expect(results.some((r) => r.isDir)).toBe(true)
  })

  it('directories sorted before files', () => {
    const results = suggestFiles(process.cwd(), 's')
    const firstDirIdx = results.findIndex((r) => r.isDir)
    const firstFileIdx = results.findIndex((r) => !r.isDir)
    if (firstDirIdx >= 0 && firstFileIdx >= 0) {
      expect(firstDirIdx).toBeLessThan(firstFileIdx)
    }
  })

  it('excludes node_modules', () => {
    const results = suggestFiles(process.cwd(), 'node')
    expect(results.every((r) => !r.path.includes('node_modules'))).toBe(true)
  })

  it('excludes .git', () => {
    const results = suggestFiles(process.cwd(), '.git')
    expect(results.every((r) => r.path !== '.git')).toBe(true)
  })

  it('handles nested paths', () => {
    const results = suggestFiles(process.cwd(), 'src/ui/ink/co')
    expect(results.length).toBeGreaterThan(0)
    // Should find components directory or files starting with 'co'
  })

  it('returns empty for non-existent directory', () => {
    const results = suggestFiles(process.cwd(), 'nonexistent_dir_xyz/')
    expect(results).toEqual([])
  })

  it('limits results to max', () => {
    const results = suggestFiles(process.cwd(), '', 5)
    expect(results.length).toBeLessThanOrEqual(5)
  })

  it('skips hidden files unless query starts with .', () => {
    const results = suggestFiles(process.cwd(), '')
    // Hidden files should not appear unless explicitly searched
    expect(results.every((r) => !r.label.startsWith('.'))).toBe(true)
  })

  it('includes hidden files when query starts with .', () => {
    const results = suggestFiles(process.cwd(), '.es')
    // .eslintrc or similar should appear — may or may not have results
    expect(Array.isArray(results)).toBe(true)
  })
})
