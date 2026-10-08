import { join } from 'node:path'
import { formatInstructionsForPrompt, resolveInstructionsSync } from '../core/instructionResolver.js'

export interface OvogoMdFile {
  path: string
  content: string
  type: 'user' | 'project' | 'project-private'
  scope?: string
  digest?: string
}

export function loadOvogoMd(cwd: string): OvogoMdFile[] {
  return resolveInstructionsSync(cwd, []).map(entry => ({
    ...entry,
    type: entry.scope === '*' ? 'user' : entry.path === join(entry.scope, '.ovogo', 'OVOGO.md') ? 'project-private' : 'project',
  }))
}

export function formatOvogoMdForPrompt(files: OvogoMdFile[]): string {
  if (!files.length) return ''
  if (files.every(file => file.scope !== undefined && file.digest !== undefined)) {
    return formatInstructionsForPrompt(files.map(file => ({ path: file.path, scope: file.scope!, digest: file.digest!, content: file.content })))
  }
  const sections = files.map(file => {
    const label = file.type === 'user'
      ? '(your personal global instructions — not checked into the project)'
      : file.type === 'project'
        ? '(project instructions, checked into the codebase)'
        : '(project-private instructions — not checked in)'
    return `Contents of ${file.path} ${label}:\n\n${file.content}`
  })
  return `## Project & User Instructions\n\n${sections.join('\n\n---\n\n')}`
}
