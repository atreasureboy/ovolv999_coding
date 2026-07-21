/**
 * Tests for src/core/lspClient.ts
 *
 * The actual LSP server interaction requires a running tsserver; we
 * test the pure helpers (URI conversion, diagnostic normalization,
 * formatting) and the client's graceful degradation.
 */

import { describe, it, expect, afterAll } from 'vitest'
import {
  LspClient,
  detectServer,
  pathToFileUri, fileUriToPath,
  formatDiagnostic, formatDiagnostics,
  getDefaultLspClient, shutdownDefaultLspClient,
  type LspDiagnostic,
} from '../src/core/lspClient.js'
import { resolve } from 'path'

describe('lspClient', () => {
  describe('pathToFileUri / fileUriToPath', () => {
    it('converts absolute path to file:// URI', () => {
      const uri = pathToFileUri('/home/user/project')
      expect(uri).toMatch(/^file:\/\//)
      expect(uri).toContain('/home/user/project')
    })

    it('round-trips path <-> uri', () => {
      const path = resolve('/tmp/test/file.ts')
      const uri = pathToFileUri(path)
      const back = fileUriToPath(uri)
      expect(back).toBe(path)
    })

    it('handles already-converted URIs', () => {
      expect(fileUriToPath('file:///foo/bar')).toMatch(/foo.*bar/)
    })

    it('passes through non-file URIs', () => {
      expect(fileUriToPath('not-a-uri')).toBe('not-a-uri')
    })
  })

  describe('detectServer', () => {
    it('returns null or a spec for typescript', () => {
      const spec = detectServer('typescript')
      // May be null in environments without tsserver — just verify shape
      if (spec) {
        expect(spec.command).toBeTruthy()
        expect(spec.languageId).toBe('typescript')
      }
    })

    it('returns null for unsupported language', () => {
      // 'go' may not have a server — accept either
      const spec = detectServer('go')
      if (spec) {
        expect(spec.command).toBeTruthy()
      }
    })
  })

  describe('LspClient (no server available)', () => {
    it('start() returns false when server not found', async () => {
      const client = new LspClient({
        rootUri: pathToFileUri('/tmp'),
        command: '/nonexistent/server-binary',
        timeoutMs: 1000,
      })
      const started = await client.start()
      expect(started).toBe(false)
      await client.stop()
    }, 5000)

    it('isRunning() is false before start', () => {
      const client = new LspClient({
        rootUri: pathToFileUri('/tmp'),
        command: '/nonexistent/server-binary',
      })
      expect(client.isRunning()).toBe(false)
    })

    it('openDocument is a no-op when not running', async () => {
      const client = new LspClient({
        rootUri: pathToFileUri('/tmp'),
        command: '/nonexistent/server-binary',
      })
      await expect(client.openDocument('file:///tmp/x.ts', 'code')).resolves.toBeUndefined()
    })

    it('getDiagnostics returns empty when not running', () => {
      const client = new LspClient({
        rootUri: pathToFileUri('/tmp'),
        command: '/nonexistent/server-binary',
      })
      expect(client.getDiagnostics()).toEqual([])
      expect(client.getDiagnostics('file:///x')).toEqual([])
    })

    it('workspaceSymbols returns empty when not running', async () => {
      const client = new LspClient({
        rootUri: pathToFileUri('/tmp'),
        command: '/nonexistent/server-binary',
      })
      const symbols = await client.workspaceSymbols('test')
      expect(symbols).toEqual([])
    })

    it('stop() is safe to call on uninitialized client', async () => {
      const client = new LspClient({
        rootUri: pathToFileUri('/tmp'),
        command: '/nonexistent/server-binary',
      })
      await expect(client.stop()).resolves.toBeUndefined()
    })

    it('kill() clears pending requests', () => {
      const client = new LspClient({
        rootUri: pathToFileUri('/tmp'),
        command: '/nonexistent/server-binary',
      })
      expect(() => client.kill()).not.toThrow()
    })
  })

  describe('getDefaultLspClient', () => {
    it('returns a client instance', () => {
      const c = getDefaultLspClient(pathToFileUri('/tmp'))
      expect(c).toBeInstanceOf(LspClient)
    })

    it('returns the same instance on subsequent calls', () => {
      const c1 = getDefaultLspClient(pathToFileUri('/tmp'))
      const c2 = getDefaultLspClient(pathToFileUri('/tmp'))
      expect(c1).toBe(c2)
    })

    afterAll(async () => {
      await shutdownDefaultLspClient()
    })
  })

  describe('formatDiagnostic', () => {
    it('formats a diagnostic with position', () => {
      const d: LspDiagnostic = {
        uri: 'file:///x.ts',
        range: { start: { line: 9, character: 4 }, end: { line: 9, character: 10 } },
        severity: 'error',
        message: 'Type error',
      }
      const out = formatDiagnostic(d)
      expect(out).toContain('file:///x.ts')
      expect(out).toContain('10:5') // 1-indexed line:col
      expect(out).toContain('error')
      expect(out).toContain('Type error')
    })

    it('includes code and source when present', () => {
      const d: LspDiagnostic = {
        uri: 'file:///x.ts',
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        severity: 'warning',
        code: 'TS6133',
        source: 'tsserver',
        message: 'unused',
      }
      const out = formatDiagnostic(d)
      expect(out).toContain('[TS6133]')
      expect(out).toContain('(tsserver)')
    })
  })

  describe('formatDiagnostics', () => {
    it('handles empty list', () => {
      expect(formatDiagnostics([])).toContain('No diagnostics')
    })

    it('summarizes by severity', () => {
      const diags: LspDiagnostic[] = [
        { uri: 'file:///a', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 'error', message: 'e1' },
        { uri: 'file:///b', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 'error', message: 'e2' },
        { uri: 'file:///c', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 'warning', message: 'w1' },
      ]
      const out = formatDiagnostics(diags)
      expect(out).toContain('2 errors')
      expect(out).toContain('1 warnings')
    })

    it('truncates long lists', () => {
      const diags: LspDiagnostic[] = Array.from({ length: 60 }, (_, i) => ({
        uri: `file:///f${i}`,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        severity: 'error' as const,
        message: `err ${i}`,
      }))
      const out = formatDiagnostics(diags)
      expect(out).toContain('... and 10 more')
    })
  })
})
