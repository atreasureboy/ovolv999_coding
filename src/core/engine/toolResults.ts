import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StreamingToolCall } from './toolPolicy.js'

const MAX_RESULT_CHARS = 20_000
const MAX_BATCH_CHARS = 60_000

function persistResult(content: string, sessionDir: string): string | undefined {
  try {
    const dir = join(sessionDir, 'tool-results')
    mkdirSync(dir, { recursive: true })
    const name = `result_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`
    const path = join(dir, name)
    writeFileSync(path, content, 'utf8')
    return `${content.slice(0, 2000)}\n\n[... Full output (${content.length} chars) saved to: ${path} ...]`
  } catch {
    return undefined
  }
}

export function truncateToolResult(content: string, sessionDir?: string): string {
  if (content.length <= MAX_RESULT_CHARS) return content
  const persisted = sessionDir ? persistResult(content, sessionDir) : undefined
  if (persisted !== undefined) return persisted
  const half = MAX_RESULT_CHARS / 2
  return (
    content.slice(0, half) +
    `\n\n[... ${content.length - MAX_RESULT_CHARS} chars truncated ...]\n\n` +
    content.slice(-half)
  )
}

export function enforceAggregateToolResultBudget(
  results: Array<{ content: string; tc: Pick<StreamingToolCall, 'id' | 'name'> }>,
  sessionDir?: string,
): void {
  let total = results.reduce((sum, result) => sum + result.content.length, 0)
  if (total <= MAX_BATCH_CHARS || results.length === 0) return
  const target = Math.max(1, Math.floor(MAX_BATCH_CHARS / results.length))
  const largestFirst = [...results].sort(
    (left, right) => right.content.length - left.content.length,
  )
  const marker = '\n[output truncated to fit aggregate budget]\n'
  for (const result of largestFirst) {
    if (total <= MAX_BATCH_CHARS) break
    const original = result.content
    if (original.length <= target) continue
    const persisted =
      original.length > MAX_RESULT_CHARS && sessionDir
        ? persistResult(original, sessionDir)
        : undefined
    if (persisted !== undefined) result.content = persisted
    else {
      const budget = Math.max(0, target - marker.length)
      const head = Math.floor(budget / 2)
      const tail = budget - head
      result.content =
        target <= marker.length
          ? marker.slice(0, target)
          : original.slice(0, head) + marker + (tail ? original.slice(-tail) : '')
    }
    total += result.content.length - original.length
  }
}
