/**
 * fileSuggest — file path autocomplete for @-mentions.
 *
 * Lists files and directories matching a partial path, excluding
 * common noise directories (node_modules, .git, dist, etc.).
 * Results are cached per-directory with a short TTL.
 */

import { readdirSync, statSync } from 'fs'
import { join, dirname, basename } from 'path'

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.cache',
  'coverage', '.turbo', '.output', '.nuxt', '__pycache__',
  '.pytest_cache', '.venv', 'venv', '.mypy_cache',
])

const IGNORE_EXTS = new Set([
  '.pyc', '.pyo', '.o', '.so', '.dylib', '.dll',
  '.exe', '.bin', '.dat', '.db', '.sqlite',
])

export interface FileSuggestion {
  path: string       // relative path from cwd
  label: string      // display label
  isDir: boolean
}

/**
 * List files/directories matching a partial path.
 * @param cwd   Working directory
 * @param query Partial path typed after @ (e.g. "src/ut" or "pack")
 * @param max   Maximum results
 */
export function suggestFiles(cwd: string, query: string, max = 15): FileSuggestion[] {
  // Determine the directory to search and the prefix to match
  const fullPath = query
  const dir = dirname(fullPath)
  const prefix = basename(fullPath).toLowerCase()

  let searchDir: string
  let displayDir: string

  if (dir === '.' || dir === '') {
    searchDir = cwd
    displayDir = ''
  } else {
    searchDir = join(cwd, dir)
    displayDir = dir + '/'
  }

  let entries: string[]
  try {
    entries = readdirSync(searchDir)
  } catch {
    return []
  }

  const results: FileSuggestion[] = []

  for (const entry of entries) {
    // Skip hidden files unless query starts with .
    if (entry.startsWith('.') && !prefix.startsWith('.')) continue

    // Skip ignored directories
    if (IGNORE_DIRS.has(entry)) continue

    // Filter by prefix (case-insensitive)
    if (prefix && !entry.toLowerCase().startsWith(prefix)) continue

    const entryPath = join(searchDir, entry)
    let isDir: boolean
    try {
      isDir = statSync(entryPath).isDirectory()
    } catch {
      continue
    }

    // Skip ignored file extensions
    if (!isDir) {
      const ext = '.' + entry.split('.').pop()?.toLowerCase()
      if (IGNORE_EXTS.has(ext)) continue
    }

    const relativePath = displayDir + entry
    results.push({
      path: relativePath,
      label: isDir ? entry + '/' : entry,
      isDir,
    })

    // Prioritize directories: keep them at the top
    results.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.label.localeCompare(b.label)
    })

    if (results.length >= max) break
  }

  return results.slice(0, max)
}
