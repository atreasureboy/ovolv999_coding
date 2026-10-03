import type { Command } from './index.js'
import { text } from './results.js'
import { join } from 'path'

export const transcriptCommands: Command[] = [
  {
    name: 'export',
    description: 'Export conversation. Usage: /export [md|json|text|transcript] [filename]',
    handler: async (args, ctx) => {
      if (ctx.history.length === 0) {
        return text('No conversation to export.')
      }
      const parts = args.trim().split(/\s+/)
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
      const format = args.trim() || 'markdown'
      const maskedHistory = ctx.history.map((msg) => {
        if (typeof msg.content === 'string') {
          return { ...msg, content: maskSecrets(msg.content).masked }
        }
        return msg
      })
      const filename = defaultFilename(format as 'markdown' | 'json' | 'text')
      const exportPath = ctx.sessionDir ? join(ctx.sessionDir, filename) : join(ctx.cwd, filename)
      try {
        exportSessionToFile(maskedHistory, ctx.cwd, filename, {
          format: format as 'markdown' | 'json' | 'text',
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
      const parts = args.trim().split(/\s+/)
      const formatArg = parts[0] ?? 'markdown'
      const format = (['markdown', 'json', 'text'].includes(formatArg) ? formatArg : 'markdown') as
        | 'markdown'
        | 'json'
        | 'text'
      if (parts.includes('stats')) {
        const sessionId = ctx.sessionDir ?? 'current'
        const transcript = buildTranscript(
          {
            sessionId,
            startTime: new Date().toISOString(),
          },
          [],
        )
        return text(formatStats(getTranscriptStats(transcript)))
      }
      const messages =
        (
          ctx as {
            messages?: Array<{
              role: string
              content: string
            }>
          }
        ).messages ?? []
      const transcript = buildTranscript(
        {
          sessionId: ctx.sessionDir ?? `session-${Date.now()}`,
          startTime: new Date().toISOString(),
          cwd: ctx.cwd,
        },
        messages.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
          timestamp: new Date().toISOString(),
        })),
      )
      const path = exportTranscript(transcript, format)
      return text(
        `Transcript exported to: ${path}\n\nStats:\n${formatStats(getTranscriptStats(transcript))}`,
      )
    },
  },
]
