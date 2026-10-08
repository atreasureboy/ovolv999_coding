/**
 * FileEditTool — exact string replacement in files
 * Reference: src/tools/FileEditTool/
 *
 * File edits must be EXACT string matches (including whitespace/indentation).
 * This prevents accidental changes and makes diffs reviewable.
 */

import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import { EDIT_FILE_DESCRIPTION } from '../prompts/tools.js'
import { statSafely } from '../core/atomicWrite.js'
import { observeFileMutation, persistFileMutation, prepareFileMutation, resolveFileOperation } from './fileOperations.js'
import { formatEditedFile, formatReplacementDiff } from './fileEditFormatting.js'

export interface EditFileInput {
  file_path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}

export class FileEditTool implements Tool {
  name = 'Edit'
  metadata = { mutatesState: true, concurrencySafe: false }

  /**
   * Hard upper bound on file size Edit will attempt. Files larger than
   * this are rejected with a clear error pointing at Write — Edit is
   * meant for surgical changes to source files, and lifting a 100MB
   * file into memory just to find/replace a token is wasteful and
   * dangerous. 25MB is large enough for normal source files (a 25MB
   * minified JS bundle is still over an order of magnitude above any
   * reasonable source file) but small enough to bound the worst case.
   */
  static readonly MAX_FILE_BYTES = 25 * 1024 * 1024

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'Edit',
      description: EDIT_FILE_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Absolute path to the file to edit',
          },
          old_string: {
            type: 'string',
            description: 'Exact string to find (must be unique in the file unless replace_all=true)',
          },
          new_string: {
            type: 'string',
            description: 'Replacement string',
          },
          replace_all: {
            type: 'boolean',
            description: 'Replace all occurrences (default: false)',
          },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const { file_path: rawPath, old_string, new_string, replace_all } = input as unknown as EditFileInput

    const operation = resolveFileOperation(rawPath, context)
    if ('error' in operation) return operation.error
    const { filePath: file_path, fileState } = operation
    if (typeof old_string !== 'string') {
      return { content: 'Error: old_string must be a string', isError: true }
    }
    if (typeof new_string !== 'string') {
      return { content: 'Error: new_string must be a string', isError: true }
    }
    if (old_string === new_string) {
      return { content: 'Error: old_string and new_string are identical — no change needed', isError: true }
    }

    // 25MB hard cap on file size — refuse before any read. Edit is meant
    // for surgical source-file changes; lifting a huge file into memory
    // just to find/replace a token is wasteful and risks OOM on modest
    // hosts. Use Write to regenerate a large file from scratch if needed.
    if (existsSync(file_path)) {
      const sz = await statSafely(file_path)
      if (sz !== null && sz.size > FileEditTool.MAX_FILE_BYTES) {
        return {
          content:
            `Error: ${file_path} is ${sz.size} bytes, exceeding the 25MB Edit cap ` +
            `(${FileEditTool.MAX_FILE_BYTES} bytes). Edit is meant for surgical ` +
            `changes — use Write to regenerate the file, or use a ` +
            `streamed tool for bulk replacement.`,
          isError: true,
        }
      }
    }

    // Enforce read-before-edit (like Claude Code — prevents blind edits)
    if (existsSync(file_path) && !fileState.hasFileBeenRead(file_path)) {
      return {
        content: `Error: You must Read ${file_path} before editing it. Use the Read tool first to see the current contents.`,
        isError: true,
      }
    }

    try {
      // ── TOCTOU window coverage map ───────────────────────────────────────
      // This function defends against external writers at FOUR distinct
      // checkpoints. Between checkpoints there are unavoidable windows
      // (the file may keep changing in the gaps). For each window we list
      // which guard (if any) catches the change, and what the cost of
      // closing it would be.
      //
      //   A. before our read          → fileState.hasFileChanged(file_path, content)
      //                                  (uses cache hash; catches same-
      //                                   mtime/same-size swaps that the
      //                                   pre-read mtime+size check misses)
      //   B. between preStat and read  → postStat mtime/size check (#1)
      //   C. between read and postStat → content-equality re-read (#2)
      //   D. between re-read and write → NOT GUARDED. Closing this would
      //                                  require file-locking (flock) or
      //                                  a CAS retry loop with the rename.
      //                                  We accept this last small window
      //                                  because the cost of locking on
      //                                  every Edit is high and the
      //                                  window is microseconds.
      //
      // ─────────────────────────────────────────────────────────────────────
      //
      // Snapshot the file's mtime+size BEFORE reading its content. After we
      // compute the replacement we re-stat and bail if the file changed
      // underneath us — closing window B (the read-modify-write TOCTOU).
      // The post-readFile hasFileChanged check below covers window A.
      const preStat = await statSafely(file_path)

      const content = await readFile(file_path, 'utf8')

      // Stale-content guard (window A) — placed AFTER readFile so we can
      // pass the just-read content to hasFileChanged and exercise the
      // SHA-256 hash layer. A pre-read fileState.hasFileChanged() (mtime+size only)
      // cannot detect a same-mtime / same-size replacement, so the guard
      // used to miss that case for swaps that happened between the prior
      // user-Read and Edit. The cost of moving the guard past the read is
      // one read for stale files, which is acceptable — Edit was about
      // to read anyway.
      if (fileState.hasFileChanged(file_path, content)) {
        return {
          content:
            `Error: ${file_path} has been modified since you last read it ` +
            `(by a linter, formatter, or the user). Read the file again ` +
            `before editing to avoid losing changes.`,
          isError: true,
        }
      }

      const occurrences = countOccurrences(content, old_string)

      if (occurrences === 0) {
        // Provide diagnostic info to help the LLM fix its edit
        const suggestion = findClosestMatch(content, old_string)
        return {
          content: `Error: old_string not found in ${file_path}.\n${suggestion}`,
          isError: true,
        }
      }

      if (!replace_all && occurrences > 1) {
        return {
          content: `Error: old_string appears ${occurrences} times in ${file_path}. Provide more surrounding context to make it unique, or use replace_all=true.`,
          isError: true,
        }
      }

      const newContent = replace_all
        ? content.split(old_string).join(new_string)
        : content.replace(old_string, () => new_string) // arrow fn prevents $ pattern interpretation

      // TOCTOU guard #1 — mtime+size. Cheap; catches most external writers.
      const postStat = await statSafely(file_path)
      if (
        preStat === null ||
        postStat === null ||
        preStat.mtimeMs !== postStat.mtimeMs ||
        preStat.size !== postStat.size
      ) {
        return {
          content:
            `Error: ${file_path} was modified by another writer during the edit. ` +
            `Read the file again to get current content before retrying.`,
          isError: true,
        }
      }

      // TOCTOU guard #2 — content equality. mtime+size can fail to detect a
      // same-size replacement that lands within the same millisecond (e.g.
      // a formatter that saves in place on a fast disk). Re-read and
      // compare to the content we computed the replacement against. If
      // anything differs we refuse to overwrite, even when mtime/size match.
      // We don't claim strict CAS semantics — instead we surface "read again"
      // and let the caller decide.
      const reReadContent = await readFile(file_path, 'utf8')
      if (reReadContent !== content) {
        return {
          content:
            `Error: ${file_path} was modified during the edit (content mismatch, ` +
            `possibly same-size same-mtime replacement). Read the file again ` +
            `to get current content before retrying.`,
          isError: true,
        }
      }

      // Both TOCTOU guards passed — back up the current content for undo,
      // then atomically replace. trackEdit is intentionally placed AFTER
      // the guards so a refused edit doesn't create a phantom history
      // version of content we never actually changed.
      const preparationError = prepareFileMutation(file_path, context)
      if (preparationError) return preparationError

      // Atomic write — see src/core/atomicWrite.ts.
      await persistFileMutation(operation, newContent, context, 'format-pending')

      const formatNote = await formatEditedFile(file_path, fileState, context.signal)
      await observeFileMutation(file_path, context, true)
      const diff = formatReplacementDiff(old_string, new_string)

      const count = replace_all ? occurrences : 1
      return {
        content: `Edited ${file_path}: replaced ${count} occurrence${count !== 1 ? 's' : ''}${formatNote}${diff}`,
        isError: false,
      }
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException
      if (error.code === 'ENOENT') {
        return { content: `File not found: ${file_path}. Use Glob to locate it, or create it with Write first.`, isError: true }
      }
      return { content: `Error editing file: ${error.message} (code: ${error.code ?? 'unknown'})`, isError: true }
    }
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let pos = 0
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++
    pos += needle.length
  }
  return count
}

/**
 * Find a close match to help the LLM understand why the exact match failed.
 * Strips leading/trailing whitespace and checks if that version exists.
 */
function findClosestMatch(content: string, target: string): string {
  const trimmed = target.trim()
  if (content.includes(trimmed)) {
    return `Hint: A version with different whitespace was found. Check indentation — old_string must match exactly.`
  }

  // Try to find first non-trivial line of the target
  const firstLine = trimmed.split('\n')[0]?.trim()
  if (firstLine && firstLine.length > 10 && content.includes(firstLine)) {
    return `Hint: The first line "${firstLine.slice(0, 60)}..." exists in the file, but the surrounding context doesn't match. Read the file around that line to get the exact content.`
  }

  return `Hint: Use Read to view the current file content and ensure old_string matches exactly.`
}
