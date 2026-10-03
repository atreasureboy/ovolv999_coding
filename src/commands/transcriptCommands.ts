import type { Command } from './index.js'
import { text } from './results.js'
import { basename } from 'path'
import type { OpenAIMessage } from '../core/types.js'
import type { TranscriptMessage } from '../core/sessionTranscript.js'

function transcriptMessage(message: OpenAIMessage, timestamp: string): TranscriptMessage {
  const content = typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map((part) => part.type === 'text' ? part.text : '[image]').join('\n')
      : ''
  const toolCalls = message.tool_calls?.map((call) => {
    let input: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(call.function.arguments)
      input = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : { arguments: call.function.arguments }
    } catch {
      input = { arguments: call.function.arguments }
    }
    return { name: call.function.name, input }
  })
  return { role: message.role, content, timestamp, ...(toolCalls ? { toolCalls } : {}) }
}

export const transcriptCommands: Command[] = [
  {
    name: 'export',
    description: 'Export conversation. Usage: /export [md|json|text|transcript] [filename]',
    handler: async (args, ctx) => {
      if (ctx.history.length === 0) {
        return text('No conversation to export.')
      }
      const parts = args.trim().split(/\s+/).filter(Boolean)
      const formatArg = parts[0]?.toLowerCase()
      const { exportSession, exportSessionToFile, defaultFilename } =
        await import('../utils/sessionExport.js')
      const validFormats = ['md', 'markdown', 'json', 'text', 'transcript']
      let format: 'markdown' | 'json' | 'text' | 'transcript'
      let filename: string | undefined
      if (formatArg && validFormats.includes(formatArg)) {
        format =
          formatArg === 'md'
            ? 'markdown'
            : (formatArg as 'markdown' | 'json' | 'text' | 'transcript')
        filename = parts[1]
      } else if (formatArg) {
        filename = parts[0]
        format = 'markdown'
      } else {
        format = 'markdown'
      }
      filename = filename ?? defaultFilename(format)
      try {
        const path = exportSessionToFile(ctx.history, ctx.cwd, filename, { format })
        const result = exportSession(ctx.history, { format })
        return text(
          `✓ Exported ${result.messageCount} messages to: ${path}\n` +
            `Format: ${format} (${result.charCount} chars)`,
        )
      } catch (err) {
        return text(`Failed to export: ${(err as Error).message}`)
      }
    },
  },
  {
    name: 'share',
    description: 'Export conversation (masked) and show the path for sharing',
    handler: async (args, ctx) => {
      if (ctx.history.length === 0) {
        return text('No conversation to share.')
      }
      const { maskSecrets } = await import('../utils/secretScanner.js')
      const { exportSessionToFile, defaultFilename } = await import('../utils/sessionExport.js')
      const requestedFormat = args.trim() || 'markdown'
      const format = requestedFormat === 'md' ? 'markdown' : requestedFormat
      if (!['markdown', 'json', 'text', 'transcript'].includes(format)) {
        return text('Usage: /share [markdown|json|text|transcript]')
      }
      const maskedHistory = JSON.parse(JSON.stringify(ctx.history), (_key, value: unknown) =>
        typeof value === 'string' ? maskSecrets(value).masked : value,
      ) as OpenAIMessage[]
      const filename = defaultFilename(format as 'markdown' | 'json' | 'text' | 'transcript')
      try {
        const exportPath = exportSessionToFile(maskedHistory, ctx.sessionDir ?? ctx.cwd, filename, {
          format: format as 'markdown' | 'json' | 'text' | 'transcript',
          includeReasoning: false,
        })
        return text(
          `✓ Shared (secrets masked): ${exportPath}\nReview the file before sharing externally.`,
        )
      } catch (err) {
        return text('Share failed: ' + (err as Error).message)
      }
    },
  },
  {
    name: 'transcript',
    aliases: ['export-session'],
    description: 'Export session transcript. Usage: /transcript [markdown|json|text] [stats]',
    handler: async (args, ctx) => {
      const transcriptModule = await import('../core/sessionTranscript.js')
      const { buildTranscript, exportTranscript, getTranscriptStats, formatStats } =
        transcriptModule
      const parts = args.trim().split(/\s+/).filter(Boolean)
      const formatArg = parts[0] ?? 'markdown'
      const format = (['markdown', 'json', 'text'].includes(formatArg) ? formatArg : 'markdown') as
        | 'markdown'
        | 'json'
        | 'text'
      const timestamp = new Date().toISOString()
      const transcript = buildTranscript(
        {
          sessionId: ctx.sessionDir ? basename(ctx.sessionDir) : `session-${Date.now()}`,
          startTime: timestamp,
          cwd: ctx.cwd,
        },
        ctx.history.map((message) => transcriptMessage(message, timestamp)),
      )
      if (parts.includes('stats')) return text(formatStats(getTranscriptStats(transcript)))
      const path = exportTranscript(transcript, format)
      return text(
        `Transcript exported to: ${path}\n\nStats:\n${formatStats(getTranscriptStats(transcript))}`,
      )
    },
  },
]
