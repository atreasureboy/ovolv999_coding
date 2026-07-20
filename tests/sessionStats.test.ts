import { describe, it, expect } from 'vitest'
import {
  analyzeSession,
  formatSessionStats,
  formatDuration,
  formatBriefStats,
} from '../src/core/sessionStats.js'
import type { OpenAIMessage } from '../src/core/types.js'

describe('sessionStats', () => {
  const sampleMessages: OpenAIMessage[] = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Read the file src/engine.ts' },
    {
      role: 'assistant',
      content: 'Let me read that file.',
      tool_calls: [{
        id: 'tc1',
        type: 'function',
        function: { name: 'Read', arguments: '{"file_path":"src/engine.ts"}' },
      }],
    },
    {
      role: 'tool',
      content: 'export class Engine { ... }',
      tool_call_id: 'tc1',
      name: 'Read',
    },
    {
      role: 'assistant',
      content: 'I see the Engine class. Let me also check the tests.',
      tool_calls: [{
        id: 'tc2',
        type: 'function',
        function: { name: 'Bash', arguments: '{"command":"npm test"}' },
      }],
    },
    {
      role: 'tool',
      content: 'Error: test failed with exit code 1',
      tool_call_id: 'tc2',
      name: 'Bash',
    },
    { role: 'assistant', content: 'The tests are failing. Let me fix the issue.' },
  ]

  describe('analyzeSession', () => {
    it('counts total messages', () => {
      const stats = analyzeSession(sampleMessages)
      expect(stats.totalMessages).toBe(7)
    })

    it('counts messages by role', () => {
      const stats = analyzeSession(sampleMessages)
      expect(stats.messagesByRole.system).toBe(1)
      expect(stats.messagesByRole.user).toBe(1)
      expect(stats.messagesByRole.assistant).toBe(3)
      expect(stats.messagesByRole.tool).toBe(2)
    })

    it('estimates tokens', () => {
      const stats = analyzeSession(sampleMessages)
      expect(stats.estimatedInputTokens).toBeGreaterThan(0)
      expect(stats.estimatedOutputTokens).toBeGreaterThan(0)
      expect(stats.totalTokens).toBe(stats.estimatedInputTokens + stats.estimatedOutputTokens)
    })

    it('counts total tool calls', () => {
      const stats = analyzeSession(sampleMessages)
      expect(stats.totalToolCalls).toBe(2)
    })

    it('counts tool calls by name', () => {
      const stats = analyzeSession(sampleMessages)
      expect(stats.toolCallsByName.Read).toBe(1)
      expect(stats.toolCallsByName.Bash).toBe(1)
    })

    it('counts tool errors', () => {
      const stats = analyzeSession(sampleMessages)
      expect(stats.toolErrors).toBe(1) // "Error: test failed"
    })

    it('computes tool success rate', () => {
      const stats = analyzeSession(sampleMessages)
      expect(stats.toolSuccessRate).toBeCloseTo(0.5)
    })

    it('tracks files read', () => {
      const stats = analyzeSession(sampleMessages)
      expect(stats.filesRead).toContain('src/engine.ts')
    })

    it('tracks commands executed', () => {
      const stats = analyzeSession(sampleMessages)
      expect(stats.commandsExecuted).toBe(1)
    })

    it('computes unique files touched', () => {
      const stats = analyzeSession(sampleMessages)
      expect(stats.uniqueFilesTouched).toBe(1)
    })

    it('detects languages from file extensions', () => {
      const stats = analyzeSession(sampleMessages)
      expect(stats.languages['.ts']).toBe(1)
    })

    it('calculates average assistant message length', () => {
      const stats = analyzeSession(sampleMessages)
      expect(stats.avgAssistantMessageLength).toBeGreaterThan(0)
    })

    it('finds longest assistant message', () => {
      const stats = analyzeSession(sampleMessages)
      expect(stats.longestAssistantMessage).toBeGreaterThan(0)
    })

    it('handles empty session', () => {
      const stats = analyzeSession([])
      expect(stats.totalMessages).toBe(0)
      expect(stats.totalToolCalls).toBe(0)
      expect(stats.toolSuccessRate).toBe(0)
    })

    it('handles session with no tool calls', () => {
      const messages: OpenAIMessage[] = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ]
      const stats = analyzeSession(messages)
      expect(stats.totalToolCalls).toBe(0)
      expect(stats.toolSuccessRate).toBe(0)
    })

    it('handles array content', () => {
      const messages: OpenAIMessage[] = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hello world' }] as any,
        },
      ]
      const stats = analyzeSession(messages)
      expect(stats.estimatedInputTokens).toBeGreaterThan(0)
    })

    it('handles null content', () => {
      const messages: OpenAIMessage[] = [
        { role: 'assistant', content: null },
      ]
      const stats = analyzeSession(messages)
      expect(stats.totalMessages).toBe(1)
    })

    it('tracks grep and glob searches', () => {
      const messages: OpenAIMessage[] = [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: '1', type: 'function', function: { name: 'Grep', arguments: '{}' } },
            { id: '2', type: 'function', function: { name: 'Glob', arguments: '{}' } },
            { id: '3', type: 'function', function: { name: 'Grep', arguments: '{}' } },
          ],
        },
      ]
      const stats = analyzeSession(messages)
      expect(stats.grepSearches).toBe(2)
      expect(stats.globSearches).toBe(1)
    })

    it('tracks sub-agents spawned', () => {
      const messages: OpenAIMessage[] = [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: '1', type: 'function', function: { name: 'Agent', arguments: '{}' } },
            { id: '2', type: 'function', function: { name: 'Task', arguments: '{}' } },
          ],
        },
      ]
      const stats = analyzeSession(messages)
      expect(stats.subAgentsSpawned).toBe(2)
    })

    it('tracks files written and edited', () => {
      const messages: OpenAIMessage[] = [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: '1', type: 'function', function: { name: 'Write', arguments: '{"file_path":"a.ts"}' } },
            { id: '2', type: 'function', function: { name: 'Edit', arguments: '{"file_path":"b.ts"}' } },
            { id: '3', type: 'function', function: { name: 'Edit', arguments: '{"file_path":"b.ts"}' } },
          ],
        },
      ]
      const stats = analyzeSession(messages)
      expect(stats.filesWritten).toContain('a.ts')
      expect(stats.filesEdited).toEqual(['b.ts', 'b.ts'])
      expect(stats.uniqueFilesTouched).toBe(2) // a.ts and b.ts
    })
  })

  describe('formatSessionStats', () => {
    it('produces formatted output', () => {
      const stats = analyzeSession(sampleMessages)
      const out = formatSessionStats(stats)
      expect(out).toContain('Session Statistics')
      expect(out).toContain('Messages')
      expect(out).toContain('Tokens')
      expect(out).toContain('Tool calls')
    })

    it('includes role breakdown', () => {
      const stats = analyzeSession(sampleMessages)
      const out = formatSessionStats(stats)
      expect(out).toContain('system')
      expect(out).toContain('assistant')
      expect(out).toContain('tool')
    })

    it('includes token counts', () => {
      const stats = analyzeSession([{ role: 'user', content: 'a'.repeat(100) }])
      const out = formatSessionStats(stats)
      expect(out).toContain('Input')
      expect(out).toContain('Output')
    })

    it('includes tool breakdown', () => {
      const stats = analyzeSession(sampleMessages)
      const out = formatSessionStats(stats)
      expect(out).toContain('Read')
      expect(out).toContain('Bash')
      expect(out).toContain('Success rate')
    })

    it('includes file stats', () => {
      const stats = analyzeSession(sampleMessages)
      const out = formatSessionStats(stats)
      expect(out).toContain('Files touched')
    })

    it('handles empty session gracefully', () => {
      const stats = analyzeSession([])
      const out = formatSessionStats(stats)
      expect(out).toContain('Messages: 0')
    })
  })

  describe('formatDuration', () => {
    it('formats seconds', () => {
      expect(formatDuration(30)).toBe('30s')
    })

    it('formats minutes', () => {
      expect(formatDuration(90)).toBe('1m 30s')
    })

    it('formats hours', () => {
      expect(formatDuration(3725)).toBe('1h 2m')
    })

    it('formats zero', () => {
      expect(formatDuration(0)).toBe('0s')
    })
  })

  describe('formatBriefStats', () => {
    it('produces compact one-liner', () => {
      const stats = analyzeSession(sampleMessages)
      const out = formatBriefStats(stats)
      expect(out).toContain('msg')
      expect(out).toContain('tok')
      expect(out).toContain('tools')
      expect(out).toContain('files')
    })

    it('includes duration when available', () => {
      const messages = [
        { role: 'user', content: 'hi', timestamp: '2024-01-15T10:00:00Z' } as OpenAIMessage,
        { role: 'assistant', content: 'hello', timestamp: '2024-01-15T10:05:00Z' } as OpenAIMessage,
      ]
      const stats = analyzeSession(messages)
      const out = formatBriefStats(stats)
      expect(out).toContain('5m')
    })

    it('handles empty session', () => {
      const stats = analyzeSession([])
      const out = formatBriefStats(stats)
      expect(out).toContain('0')
    })
  })
})
