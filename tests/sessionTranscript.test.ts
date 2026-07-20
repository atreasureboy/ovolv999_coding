import { describe, it, expect } from 'vitest'
import {
  buildTranscript,
  formatAsJson,
  formatAsMarkdown,
  formatAsText,
  formatTranscript,
  exportTranscript,
  getTranscriptStats,
  formatStats,
  type TranscriptMessage,
  type TranscriptMetadata,
} from '../src/core/sessionTranscript.js'

function makeMessages(): TranscriptMessage[] {
  return [
    {
      role: 'user',
      content: 'Fix the bug',
      timestamp: new Date('2024-01-01T10:00:00Z').toISOString(),
    },
    {
      role: 'assistant',
      content: 'I will fix the bug.',
      timestamp: new Date('2024-01-01T10:00:05Z').toISOString(),
      model: 'gpt-4',
      toolCalls: [
        {
          name: 'Edit',
          input: { filePath: 'src/bug.ts', oldString: 'foo', newString: 'bar' },
          output: 'Edit applied',
          duration: 50,
        },
      ],
      tokenUsage: { input: 100, output: 50 },
      cost: 0.002,
    },
    {
      role: 'user',
      content: 'Thanks!',
      timestamp: new Date('2024-01-01T10:01:00Z').toISOString(),
    },
  ]
}

function makeMetadata(): TranscriptMetadata {
  return {
    sessionId: 'test-123',
    startTime: new Date('2024-01-01T10:00:00Z').toISOString(),
    endTime: new Date('2024-01-01T10:01:00Z').toISOString(),
    model: 'gpt-4',
    mode: 'default',
    cwd: '/project',
  }
}

describe('sessionTranscript', () => {
  describe('buildTranscript', () => {
    it('builds with computed totals', () => {
      const t = buildTranscript(makeMetadata(), makeMessages())
      expect(t.metadata.totalTokens).toBe(150)
      expect(t.metadata.totalCost).toBeCloseTo(0.002)
      expect(t.metadata.messageCount).toBe(3)
      expect(t.metadata.toolCallCount).toBe(1)
    })

    it('handles empty messages', () => {
      const t = buildTranscript(makeMetadata(), [])
      expect(t.metadata.totalTokens).toBe(0)
      expect(t.metadata.totalCost).toBe(0)
      expect(t.metadata.messageCount).toBe(0)
    })
  })

  describe('formatAsJson', () => {
    it('produces valid JSON', () => {
      const t = buildTranscript(makeMetadata(), makeMessages())
      const json = formatAsJson(t)
      const parsed = JSON.parse(json)
      expect(parsed.metadata.sessionId).toBe('test-123')
      expect(parsed.messages).toHaveLength(3)
    })
  })

  describe('formatAsMarkdown', () => {
    it('includes session metadata', () => {
      const t = buildTranscript(makeMetadata(), makeMessages())
      const md = formatAsMarkdown(t)
      expect(md).toContain('Session Transcript')
      expect(md).toContain('test-123')
      expect(md).toContain('gpt-4')
    })

    it('includes message content', () => {
      const t = buildTranscript(makeMetadata(), makeMessages())
      const md = formatAsMarkdown(t)
      expect(md).toContain('Fix the bug')
      expect(md).toContain('Thanks!')
    })

    it('includes tool calls', () => {
      const t = buildTranscript(makeMetadata(), makeMessages())
      const md = formatAsMarkdown(t)
      expect(md).toContain('Edit')
      expect(md).toContain('filePath')
    })

    it('includes token usage', () => {
      const t = buildTranscript(makeMetadata(), makeMessages())
      const md = formatAsMarkdown(t)
      expect(md).toContain('Tokens')
      expect(md).toContain('100')
    })
  })

  describe('formatAsText', () => {
    it('produces plain text format', () => {
      const t = buildTranscript(makeMetadata(), makeMessages())
      const txt = formatAsText(t)
      expect(txt).toContain('USER')
      expect(txt).toContain('ASSISTANT')
      expect(txt).toContain('Fix the bug')
    })
  })

  describe('formatTranscript', () => {
    it('delegates to correct formatter', () => {
      const t = buildTranscript(makeMetadata(), makeMessages())
      const json = formatTranscript(t, 'json')
      const md = formatTranscript(t, 'markdown')
      const txt = formatTranscript(t, 'text')
      expect(json).not.toBe(md)
      expect(md).not.toBe(txt)
    })
  })

  describe('exportTranscript', () => {
    it('exports to file', () => {
      const t = buildTranscript(makeMetadata(), makeMessages())
      const path = exportTranscript(t, 'markdown', 'test-export.md')
      expect(path).toContain('test-export.md')
    })
  })

  describe('getTranscriptStats', () => {
    it('computes stats correctly', () => {
      const t = buildTranscript(makeMetadata(), makeMessages())
      const stats = getTranscriptStats(t)
      expect(stats.messageCount).toBe(3)
      expect(stats.userMessages).toBe(2)
      expect(stats.assistantMessages).toBe(1)
      expect(stats.toolCalls).toBe(1)
      expect(stats.toolNames.Edit).toBe(1)
      expect(stats.totalTokens).toBe(150)
      expect(stats.totalCost).toBeCloseTo(0.002)
    })

    it('handles empty transcript', () => {
      const t = buildTranscript(makeMetadata(), [])
      const stats = getTranscriptStats(t)
      expect(stats.messageCount).toBe(0)
      expect(stats.toolCalls).toBe(0)
    })
  })

  describe('formatStats', () => {
    it('formats stats string', () => {
      const t = buildTranscript(makeMetadata(), makeMessages())
      const stats = getTranscriptStats(t)
      const out = formatStats(stats)
      expect(out).toContain('Messages: 3')
      expect(out).toContain('Edit')
      expect(out).toContain('Tokens')
    })
  })
})
