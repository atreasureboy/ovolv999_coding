import { lstatSync, realpathSync } from 'fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'path'
import type { ToolContext } from './types.js'

function containsPath(root: string, target: string): boolean {
  const fromRoot = relative(root, target)
  return fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot)
}

export function resolveCanonicalPath(target: string): string {
  let ancestor = target
  const missing: string[] = []
  for (;;) {
    try {
      lstatSync(ancestor)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) throw error
      missing.unshift(basename(ancestor))
      ancestor = parent
      continue
    }
    return resolve(realpathSync(ancestor), ...missing)
  }
}

export function resolveWorkspacePath(context: ToolContext, suppliedPath: string): string {
  const bound = context.workspaceBound || context.workspace?.worktreeName || context.parentRunId
  const root = resolve(context.workspace?.cwd ?? context.cwd)
  const target = resolve(bound ? root : context.cwd, suppliedPath)
  if (!bound) return target
  const canonicalRoot = realpathSync(root)
  if (!containsPath(root, target)) throw new Error(`Path is outside the bound workspace: ${suppliedPath}`)
  const canonicalTarget = resolveCanonicalPath(target)
  if (!containsPath(canonicalRoot, canonicalTarget)) throw new Error(`Path is outside the bound workspace: ${suppliedPath}`)
  return canonicalTarget
}
