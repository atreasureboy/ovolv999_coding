/**
 * expandAtMentions — expand @file.path references in user prompts.
 *
 * When a user types "Fix @src/utils.ts", this expands the prompt to
 * include the file's contents so the LLM has full context without
 * needing a separate Read tool call.
 *
 * Format:
 *   Fix @src/utils.ts
 *
 *   <file_content path="src/utils.ts">
 *   ...actual file contents...
 *   </file_content>
 *
 * Files larger than 8000 chars are truncated with a notice.
 * Non-existent files are silently skipped (the LLM will note the
 * @mention and can use Read to investigate).
 */

import { readFileSync, existsSync, statSync } from 'fs'
import { resolve, isAbsolute, extname } from 'path'

const MAX_FILE_CHARS = 8000
const AT_MENTION_RE = /(?:^|\s)@((?:\.\/)?(?:[A-Za-z0-9_.\-/]+))/g

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

export interface ImageMention {
  path: string
  dataUrl: string
}

export interface ExpandedMention {
  path: string
  found: boolean
  truncated: boolean
  chars: number
  isImage: boolean
}

export interface ExpansionResult {
  text: string
  mentions: ExpandedMention[]
  images: ImageMention[]
}

/**
 * Expand @file.path references in text, appending file contents.
 * Image files (.png/.jpg/.jpeg/.gif/.webp/.bmp) are collected separately
 * as base64 data URLs for multimodal message construction.
 */
export function expandAtMentions(text: string, cwd: string): ExpansionResult {
  const mentions: ExpandedMention[] = []
  const images: ImageMention[] = []
  const seen = new Set<string>()
  const orderedPaths: string[] = []

  // Collect all @mentions (dedup + preserve order)
  let match: RegExpExecArray | null
  AT_MENTION_RE.lastIndex = 0
  while ((match = AT_MENTION_RE.exec(text)) !== null) {
    const path = match[1]
    // Must look like a file path (contains a dot or /)
    if (!path.includes('.') && !path.includes('/')) continue
    if (!seen.has(path)) {
      seen.add(path)
      orderedPaths.push(path)
    }
  }

  if (orderedPaths.length === 0) {
    return { text, mentions, images }
  }

  let appendix = '\n'
  for (const relPath of orderedPaths) {
    const absPath = isAbsolute(relPath) ? relPath : resolve(cwd, relPath)

    if (!existsSync(absPath)) {
      mentions.push({ path: relPath, found: false, truncated: false, chars: 0, isImage: false })
      continue
    }

    let stat
    try {
      stat = statSync(absPath)
    } catch {
      mentions.push({ path: relPath, found: false, truncated: false, chars: 0, isImage: false })
      continue
    }

    // Skip directories
    if (stat.isDirectory()) {
      mentions.push({ path: relPath, found: false, truncated: false, chars: 0, isImage: false })
      continue
    }

    // Image files — read as base64 data URL
    const ext = extname(relPath).toLowerCase()
    if (IMAGE_EXTENSIONS.has(ext)) {
      try {
        const buf = readFileSync(absPath)
        const mime = MIME_MAP[ext] ?? 'image/png'
        const dataUrl = `data:${mime};base64,${buf.toString('base64')}`
        images.push({ path: relPath, dataUrl })
        mentions.push({ path: relPath, found: true, truncated: false, chars: buf.length, isImage: true })
      } catch {
        mentions.push({ path: relPath, found: false, truncated: false, chars: 0, isImage: true })
      }
      continue
    }

    // Text files — read as UTF-8
    let content: string
    try {
      content = readFileSync(absPath, 'utf-8')
    } catch {
      mentions.push({ path: relPath, found: false, truncated: false, chars: 0, isImage: false })
      continue
    }

    const chars = content.length
    const truncated = chars > MAX_FILE_CHARS
    if (truncated) {
      content = content.slice(0, MAX_FILE_CHARS) + `\n... (truncated, ${chars - MAX_FILE_CHARS} more chars)`
    }

    appendix += `\n<file_content path="${relPath}">\n${content}\n</file_content>\n`
    mentions.push({ path: relPath, found: true, truncated, chars, isImage: false })
  }

  return {
    text: mentions.some((m) => m.found) ? text + appendix : text,
    mentions,
    images,
  }
}
