/**
 * DiffView — inline diff display for file edits.
 *
 * Shows old → new changes with red/green coloring.
 * Used by ToolCallView when a Write/Edit tool produces a diff.
 *
 * This is a presentational component — the diff computation happens
 * in the caller (or could be extracted to a utility).
 */

import { Text, Box } from 'ink'

export interface DiffLine {
  type: 'add' | 'remove' | 'context'
  text: string
  oldLineNum?: number
  newLineNum?: number
}

export function DiffView({
  lines,
  maxLines = 30,
}: {
  lines: DiffLine[]
  maxLines?: number
}): React.ReactElement {
  const shown = lines.slice(0, maxLines)
  const hidden = lines.length - shown.length

  return (
    <Box flexDirection="column" marginLeft={2}>
      {shown.map((line, i) => {
        const prefix =
          line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '
        const color =
          line.type === 'add'
            ? 'greenBright'
            : line.type === 'remove'
              ? 'redBright'
              : undefined
        const dim = line.type === 'context'

        return (
          <Box key={i}>
            <Text color={color} dimColor={dim}>
              {prefix} {line.text.length > 100 ? line.text.slice(0, 97) + '...' : line.text}
            </Text>
          </Box>
        )
      })}
      {hidden > 0 ? (
        <Text dimColor> ... {hidden} more lines</Text>
      ) : null}
    </Box>
  )
}

/**
 * Compute a simple line-level diff between old and new text.
 * Not a full LCS diff — just shows removed lines then added lines.
 * Good enough for quick visual feedback on file edits.
 */
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  const result: DiffLine[] = []

  // Simple approach: find common prefix and suffix, show middle as diff
  let prefixLen = 0
  while (
    prefixLen < oldLines.length &&
    prefixLen < newLines.length &&
    oldLines[prefixLen] === newLines[prefixLen]
  ) {
    prefixLen++
  }

  let suffixLen = 0
  while (
    suffixLen < oldLines.length - prefixLen &&
    suffixLen < newLines.length - prefixLen &&
    oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen++
  }

  // Add context (up to 3 lines before the change)
  const contextBefore = Math.min(prefixLen, 3)
  for (let i = prefixLen - contextBefore; i < prefixLen; i++) {
    result.push({ type: 'context', text: oldLines[i], oldLineNum: i + 1, newLineNum: i + 1 })
  }

  // Removed lines
  for (let i = prefixLen; i < oldLines.length - suffixLen; i++) {
    result.push({ type: 'remove', text: oldLines[i], oldLineNum: i + 1 })
  }

  // Added lines
  for (let i = prefixLen; i < newLines.length - suffixLen; i++) {
    result.push({ type: 'add', text: newLines[i], newLineNum: i + 1 })
  }

  // Context after (up to 3 lines)
  const newSuffixStart = newLines.length - suffixLen
  const contextAfter = Math.min(suffixLen, 3)
  for (let i = 0; i < contextAfter; i++) {
    const idx = newSuffixStart + i
    result.push({ type: 'context', text: newLines[idx], newLineNum: idx + 1 })
  }

  return result
}
