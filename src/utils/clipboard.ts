import { execFileSync } from 'node:child_process'

/**
 * Detect the platform clipboard write command.
 * Returns null if no clipboard tool is available.
 */
function findClipboardCmd(): { cmd: string; args: string[] } | null {
  const platform = process.platform

  // macOS
  if (platform === 'darwin') {
    return { cmd: 'pbcopy', args: [] }
  }

  // Windows (native or WSL)
  if (platform === 'win32') {
    return { cmd: 'clip', args: [] }
  }

  // Linux / other Unix — try Wayland first, then X11
  const candidates = [
    { cmd: 'wl-copy', args: [] },
    { cmd: 'xclip', args: ['-selection', 'clipboard'] },
    { cmd: 'xsel', args: ['--clipboard', '--input'] },
    { cmd: 'clip.exe', args: [] }, // WSL
  ]

  for (const c of candidates) {
    try {
      execFileSync('command', ['-v', c.cmd], { stdio: 'ignore', shell: true })
      return c
    } catch {
      // not found, try next
    }
  }

  return null
}

let cachedCmd: { cmd: string; args: string[] } | null | undefined

/**
 * Copy text to the system clipboard.
 * Returns true on success, false if no clipboard tool is available or the
 * write failed.
 */
export function copyToClipboard(text: string): boolean {
  if (cachedCmd === undefined) {
    cachedCmd = findClipboardCmd()
  }
  if (cachedCmd === null) return false

  try {
    execFileSync(cachedCmd.cmd, cachedCmd.args, {
      input: text,
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    return true
  } catch {
    return false
  }
}
