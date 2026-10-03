/**
 * Push Notification Tool — alert the user out-of-band
 *
 * Sends a desktop notification when a long-running operation finishes
 * or when the model needs user input after a wait. Bridges the gap
 * when the user has tabbed away from the terminal.
 *
 * Backends (auto-detected):
 *   macOS:     osascript -e 'display notification ...'
 *   Linux:     notify-send (libnotify)
 *   Windows:   msg (limited) / PowerShell toast
 *   Fallback:  terminal bell (\a) + stderr message
 *
 * Also supports an "escalation" mode that rings the bell repeatedly
 * for urgent attention.
 */

import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import { execFileSync } from 'child_process'

type Urgency = 'low' | 'normal' | 'critical'

export class PushNotificationTool implements Tool {
  name = 'PushNotification'
  metadata = { readOnly: true, concurrencySafe: true }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'PushNotification',
      description: `Send a desktop notification to alert the user. Use when a long task completes or when you need their attention after waiting.

## When to Use
- A background task or test suite finished and the user may have tabbed away
- You've been waiting and now need user input
- A critical error occurred that the user should know about immediately

## When NOT to Use
- For routine status updates (just include them in your reply)
- More than once per turn (don't spam)

## Behavior
Auto-detects the platform notification system (osascript on macOS, notify-send on Linux, PowerShell toast on Windows) and falls back to a terminal bell.`,
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short title for the notification (max ~60 chars).' },
          message: { type: 'string', description: 'Notification body text.' },
          urgency: {
            type: 'string',
            enum: ['low', 'normal', 'critical'],
            description: 'Priority. critical may ring the bell repeatedly.',
          },
        },
        required: ['title', 'message'],
      },
    },
  }

  isConcurrencySafe(): boolean {
    return true
  }

  execute(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    return new Promise(resolve => resolve(this.executeSync(input, _ctx)))
  }

  private executeSync(input: Record<string, unknown>, _ctx: ToolContext): ToolResult {
    const title = typeof input.title === 'string' ? input.title.trim() : ''
    const message = typeof input.message === 'string' ? input.message.trim() : ''
    const urgency = (input.urgency as Urgency) ?? 'normal'

    if (!title || !message) {
      return { content: 'Error: title and message are required', isError: true }
    }

    const results: string[] = []
    let delivered = false

    // Try each backend in priority order
    for (const backend of getBackends()) {
      try {
        const result = backend.send(title, message, urgency)
        if (result) {
          results.push(`${backend.name}: sent`)
          delivered = true
          break
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        results.push(`${backend.name}: failed (${msg})`)
      }
    }

    // Fallback: terminal bell
    if (!delivered) {
      try {
        process.stderr.write('\x07') // BEL
        if (urgency === 'critical') {
          // Triple-bell for critical urgency
          process.stderr.write('\x07\x07')
        }
        results.push('terminal-bell: sent')
        delivered = true
      } catch (error) {
        results.push(`terminal-bell: failed (${error instanceof Error ? error.message : String(error)})`)
      }
    }

    const summary = delivered
      ? `Notification delivered: "${title}"`
      : `Notification failed:\n${results.join('\n')}`

    return { content: summary, isError: !delivered }
  }
}

// ── Backends ────────────────────────────────────────────────────────────────

interface NotificationBackend {
  name: string
  send: (title: string, message: string, urgency: Urgency) => boolean
}

function getBackends(): NotificationBackend[] {
  const backends: NotificationBackend[] = []

  if (process.platform === 'darwin') {
    backends.push({
      name: 'osascript',
      send: (title, message, urgency) => {
        const sound = urgency === 'critical' ? 'Basso' : urgency === 'low' ? 'Glass' : 'Ping'
        execFileSync(
          'osascript', ['-e', `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name ${JSON.stringify(sound)}`],
          { stdio: 'pipe', timeout: 5000 },
        )
        return true
      },
    })
  }

  if (process.platform === 'linux') {
    backends.push({
      name: 'notify-send',
      send: (title, message, urgency) => {
        execFileSync('notify-send', ['-u', urgency, '--', title, message], {
          stdio: 'pipe', timeout: 5000,
        })
        return true
      },
    })
  }

  if (process.platform === 'win32') {
    backends.push({
      name: 'powershell-toast',
      send: (title, message) => {
        const script = `
          [System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null
          $balloon = New-Object System.Windows.Forms.NotifyIcon
          $balloon.Icon = [System.Drawing.SystemIcons]::Information
          $balloon.BalloonTipTitle = '${title.replace(/'/g, "''")}'
          $balloon.BalloonTipText = '${message.replace(/'/g, "''")}'
          $balloon.Visible = $true
          $balloon.ShowBalloonTip(5000)
        `.replace(/\n/g, ' ')
        execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
          stdio: 'pipe', timeout: 8000, windowsHide: true,
        })
        return true
      },
    })
  }

  return backends
}
