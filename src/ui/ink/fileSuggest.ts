/**
 * fileSuggest — file path autocomplete for @-mentions.
 *
 * Lists files and directories matching a partial path, excluding
 * common noise directories (node_modules, .git, dist, etc.).
 * Results are cached per-directory with a short TTL.
 *
 * Matching strategy:
 * 1. Prefix match in the immediate directory (existing behavior)
 * 2. If fewer than `max` results, fall back to fuzzy subsequence
 *    matching across the entire project tree (cached).
 */

import { readdirSync, statSync } from 'fs'
import { join, dirname, basename, relative, sep as pathSep } from 'path'

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.cache',
  'coverage', '.turbo', '.output', '.nuxt', '__pycache__',
  '.pytest_cache', '.venv', 'venv', '.mypy_cache',
  // Common large vendor / reference directories
  'claude-code', 'vendor', 'third_party', 'deps', '_build',
  'target', '.sveltekit', '.gradle', '.idea',
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

// ── Recursive project tree cache ────────────────────────────────────────────

interface TreeCache {
  root: string
  files: string[]    // relative paths
  expires: number
}

let treeCache: TreeCache | null = null
const TREE_TTL_MS = 10_000   // cache the file tree for 10 seconds

const MAX_TREE_DEPTH = 8
const MAX_TREE_FILES = 5000

function buildTree(root: string, maxDepth = MAX_TREE_DEPTH): string[] {
  const results: string[] = []
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  while (stack.length > 0 && results.length < MAX_TREE_FILES) {
    const { dir, depth } = stack.pop()!
    if (depth > maxDepth) continue
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry)) continue
      if (entry.startsWith('.')) continue
      const fullPath = join(dir, entry)
      let isDir: boolean
      try {
        isDir = statSync(fullPath).isDirectory()
      } catch {
        continue
      }
      if (isDir) {
        stack.push({ dir: fullPath, depth: depth + 1 })
        continue  // Only files go into results
      }
      const ext = '.' + entry.split('.').pop()?.toLowerCase()
      if (IGNORE_EXTS.has(ext)) continue
      const rel = relative(root, fullPath).split(pathSep).join('/')
      results.push(rel)
    }
  }
  return results
}

function getTree(root: string): string[] {
  const now = Date.now()
  if (treeCache && treeCache.root === root && now < treeCache.expires) {
    return treeCache.files
  }
  const files = buildTree(root)
  treeCache = { root, files, expires: now + TREE_TTL_MS }
  return files
}

// ── Fuzzy subsequence matching ──────────────────────────────────────────────

export interface FuzzyResult {
  path: string
  /** Indices in `path` that matched the query (for highlighting). */
  matchedIndices: number[]
  /** Lower = better match. */
  score: number
}

/**
 * Fuzzy match: query characters must appear as a subsequence in `target`,
 * in order. Returns null if not a subsequence match.
 * Lower score = better (penalizes gaps and non-boundary matches).
 */
export function fuzzyMatch(query: string, target: string): FuzzyResult | null {
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  const matchedIndices: number[] = []
  let qi = 0
  let prevMatch = -2
  let score = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      matchedIndices.push(ti)
      // Boundary bonus: match at word boundaries (camelCase, -, _, /, .)
      const prev = t[ti - 1]
      const isBoundary = ti === 0 || prev === '/' || prev === '_' || prev === '-' || prev === '.' || (prev !== undefined && prev !== prev.toUpperCase() && t[ti] === t[ti].toUpperCase())
      if (isBoundary) score -= 5
      // Consecutive bonus
      if (ti === prevMatch + 1) score -= 4
      // Gap penalty (weighted heavily so gappy matches rank low)
      if (prevMatch >= 0 && ti > prevMatch + 1) score += (ti - prevMatch - 1) * 3
      prevMatch = ti
      qi++
    }
  }
  if (qi < q.length) return null  // query not fully consumed → not a match
  // Prefer shorter targets (less noise)
  score += target.length * 0.1
  return { path: target, matchedIndices, score }
}

// ── Main entry point ────────────────────────────────────────────────────────

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

  // ── Phase 1: Prefix match in immediate directory ──────────────────────────
  const prefixResults: FileSuggestion[] = []
  let entries: string[]
  try {
    entries = readdirSync(searchDir)
  } catch {
    entries = []
  }

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
    prefixResults.push({
      path: relativePath,
      label: isDir ? entry + '/' : entry,
      isDir,
    })

    if (prefixResults.length >= max) break
  }

  // Sort prefix results: directories first, then alphabetical
  prefixResults.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.label.localeCompare(b.label)
  })

  if (prefixResults.length >= max) return prefixResults.slice(0, max)

  // ── Phase 2: Fuzzy fallback across project tree ───────────────────────────
  // Only when prefix match yields fewer than max results.
  if (query.length < 2) return prefixResults

  const tree = getTree(cwd)
  const fuzzyMatches: FuzzyResult[] = []

  // Build a set of already-found paths to avoid duplicates
  const existing = new Set(prefixResults.map((r) => r.path))

  for (const filePath of tree) {
    if (existing.has(filePath)) continue
    const match = fuzzyMatch(query, filePath)
    if (match) {
      fuzzyMatches.push(match)
    }
  }

  fuzzyMatches.sort((a, b) => a.score - b.score)

  const remaining = max - prefixResults.length
  for (const fm of fuzzyMatches.slice(0, remaining)) {
    prefixResults.push({
      path: fm.path,
      label: fm.path,
      isDir: false,
    })
  }

  return prefixResults.slice(0, max)
}
