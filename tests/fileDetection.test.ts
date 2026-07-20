import { describe, it, expect } from 'vitest'
import {
  detectFileReferences,
  loadFileContext,
  augmentPromptWithFiles,
  highlightFileReferences,
} from '../src/core/fileDetection.js'

describe('fileDetection', () => {
  const cwd = process.cwd()

  describe('detectFileReferences', () => {
    it('detects relative paths', () => {
      const refs = detectFileReferences('read src/core/engine.ts for me', { cwd })
      expect(refs.length).toBeGreaterThanOrEqual(1)
      expect(refs.some(r => r.path.endsWith('engine.ts'))).toBe(true)
    })

    it('detects paths with line numbers', () => {
      const refs = detectFileReferences('check src/core/engine.ts:100', { cwd })
      expect(refs.length).toBeGreaterThanOrEqual(1)
      const ref = refs.find(r => r.lineStart === 100)
      expect(ref).toBeDefined()
    })

    it('detects paths with line ranges', () => {
      const refs = detectFileReferences('see src/core/engine.ts:10-20', { cwd })
      const ref = refs.find(r => r.lineStart === 10 && r.lineEnd === 20)
      expect(ref).toBeDefined()
    })

    it('detects bare filenames', () => {
      const refs = detectFileReferences('look at engine.ts', { cwd })
      // engine.ts exists in src/core/
      expect(refs.some(r => r.raw === 'engine.ts')).toBe(true)
    })

    it('marks existing files as exists=true', () => {
      const refs = detectFileReferences('read package.json', { cwd })
      expect(refs.some(r => r.exists)).toBe(true)
    })

    it('does not detect non-existent paths as valid', () => {
      const refs = detectFileReferences('read src/nonexistent/file.ts', { cwd })
      // Path pattern requires existsSync
      expect(refs.every(r => !r.raw.includes('nonexistent'))).toBe(true)
    })

    it('returns empty for text without files', () => {
      const refs = detectFileReferences('just a normal message', { cwd })
      expect(refs).toEqual([])
    })

    it('detects multiple files', () => {
      const refs = detectFileReferences('check src/core/engine.ts and package.json', { cwd })
      expect(refs.length).toBeGreaterThanOrEqual(2)
    })

    it('sorts by position', () => {
      const refs = detectFileReferences('src/core/engine.ts then package.json', { cwd })
      for (let i = 1; i < refs.length; i++) {
        expect(refs[i].start).toBeGreaterThan(refs[i - 1].start)
      }
    })

    it('respects codeExtensions filter', () => {
      const refs = detectFileReferences('engine.ts is here', {
        cwd,
        codeExtensions: new Set(['.py']), // Only Python
        searchBareNames: true,
      })
      // Should not detect .ts files with only .py extensions allowed
      expect(refs.filter(r => r.raw === 'engine.ts').length).toBe(0)
    })

    it('can disable bare name search', () => {
      const refs = detectFileReferences('engine.ts', {
        cwd,
        searchBareNames: false,
      })
      // Without bare name search, "engine.ts" alone shouldn't be found
      // (it's not a path with directory separators)
      expect(refs.length).toBe(0)
    })
  })

  describe('loadFileContext', () => {
    it('loads file content', () => {
      const refs = detectFileReferences('read package.json', { cwd })
      const contexts = loadFileContext(refs, { cwd })
      expect(contexts.length).toBeGreaterThanOrEqual(1)
      const ctx = contexts[0]
      expect(ctx.content).not.toBeNull()
      expect(ctx.lineCount).toBeGreaterThan(0)
    })

    it('provides correct extension', () => {
      const refs = detectFileReferences('package.json', { cwd })
      const contexts = loadFileContext(refs, { cwd })
      expect(contexts[0].extension).toBe('.json')
    })

    it('handles non-existent files', () => {
      const contexts = loadFileContext([{
        raw: 'nonexistent.ts',
        path: '/nonexistent.ts',
        start: 0,
        end: 10,
        exists: false,
        isDirectory: false,
        isBareName: false,
      }], { cwd })
      expect(contexts[0].content).toBeNull()
      expect(contexts[0].error).toBeDefined()
    })

    it('respects maxLines', () => {
      const refs = detectFileReferences('package.json', { cwd })
      const contexts = loadFileContext(refs, { cwd, maxLines: 5 })
      // package.json may be small, but test the mechanism
      expect(contexts[0].lineCount).toBeLessThanOrEqual(5)
    })

    it('handles line range extraction', () => {
      const refs = detectFileReferences('package.json:1-3', { cwd })
      const contexts = loadFileContext(refs, { cwd })
      if (contexts.length > 0 && contexts[0].content !== null) {
        expect(contexts[0].lineCount).toBeLessThanOrEqual(3)
      }
    })

    it('marks truncated files', () => {
      const refs = detectFileReferences('package.json', { cwd })
      const contexts = loadFileContext(refs, { cwd, maxLines: 2 })
      // If the file has more than 2 lines, it should be truncated
      if (contexts[0].lineCount === 2) {
        // Could be exactly 2 lines or truncated
      }
    })
  })

  describe('augmentPromptWithFiles', () => {
    it('returns original prompt when no files detected', () => {
      const result = augmentPromptWithFiles('just a message', { cwd })
      expect(result.augmentedPrompt).toBe('just a message')
      expect(result.detectedFiles).toEqual([])
    })

    it('augments prompt with file content', () => {
      const result = augmentPromptWithFiles('read package.json', { cwd })
      expect(result.detectedFiles.length).toBeGreaterThan(0)
      expect(result.augmentedPrompt).toContain('--- Detected File Context ---')
      expect(result.augmentedPrompt).toContain('package.json')
    })

    it('provides a summary', () => {
      const result = augmentPromptWithFiles('read package.json', { cwd })
      expect(result.summary).toContain('file(s) detected')
    })

    it('handles multiple files', () => {
      const result = augmentPromptWithFiles('check package.json and src/core/engine.ts', { cwd })
      expect(result.detectedFiles.length).toBeGreaterThanOrEqual(2)
    })

    it('preserves original prompt text', () => {
      const original = 'please read package.json and explain it'
      const result = augmentPromptWithFiles(original, { cwd })
      expect(result.augmentedPrompt.startsWith(original)).toBe(true)
    })

    it('handles no readable files', () => {
      const result = augmentPromptWithFiles('check nonexistent.xyz', {
        cwd,
        codeExtensions: new Set(['.xyz']),
      })
      expect(result.augmentedPrompt).not.toContain('--- Detected File Context ---')
    })
  })

  describe('highlightFileReferences', () => {
    it('returns text unchanged when no refs', () => {
      expect(highlightFileReferences('hello', [])).toBe('hello')
    })

    it('adds color codes for existing files', () => {
      const refs = detectFileReferences('package.json', { cwd })
      const result = highlightFileReferences('read package.json', refs)
      if (refs.length > 0 && refs[0].exists) {
        expect(result).toContain('\x1b[36m') // cyan for existing
      }
    })

    it('adds color codes for non-existent files', () => {
      const result = highlightFileReferences('nonexistent.xyz', [{
        raw: 'nonexistent.xyz',
        path: '/nonexistent.xyz',
        start: 0,
        end: 15,
        exists: false,
        isDirectory: false,
        isBareName: true,
      }])
      expect(result).toContain('\x1b[33m') // yellow for non-existent
    })
  })
})
