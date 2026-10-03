/**
 * Git info — cached git branch detection for StatusBar.
 *
 * Runs `git rev-parse --abbrev-ref HEAD` once and caches the result.
 * Refreshed on demand (e.g. after turn execution).
 */

import { execFileSync } from 'child_process'
import { resolve } from 'path'

const cachedBranches = new Map<string, string | null>()

export function getGitBranch(cwd: string): string | null {
  const workspace = resolve(cwd)
  if (cachedBranches.has(workspace)) return cachedBranches.get(workspace) ?? null
  let cachedBranch: string | null
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: workspace,
      timeout: 2000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    cachedBranch = branch || null
  } catch {
    cachedBranch = null
  }
  cachedBranches.set(workspace, cachedBranch)
  return cachedBranch
}

/** Force re-detection (call after git operations). */
export function refreshGitBranch(): void {
  cachedBranches.clear()
}
