import type { Command } from './index.js'
import { text } from './results.js'
import type { SlashCommandResult } from './index.js'
import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { execSync, execFileSync } from 'child_process'
import type { EditedFileInfo } from '../core/fileHistory.js'

export const workspaceCommands: Command[] = [
  {
    name: 'rewind',
    description: 'List file edits in this session (read-only — restore is not supported)',
    usage: '/rewind',
    handler: (_args, ctx) => {
      const fh = ctx.engine.getFileHistory()
      if (!fh) {
        return text('File history not available (no session directory configured).')
      }
      const files = fh.getEditedFiles()
      if (files.length === 0) {
        return text('No file edits tracked in this session.')
      }
      return text(fh.getSummary() + '\n\nUse /undo to restore a file to its pre-edit state.')
    },
  },
  {
    name: 'undo',
    description: 'Undo the last file edit (restore previous version)',
    usage: '/undo [file path]',
    handler: (args, ctx) => {
      const fh = ctx.engine.getFileHistory()
      if (!fh) {
        return text('File history not available (no session directory configured).')
      }
      const files = fh.getEditedFiles()
      if (files.length === 0) {
        return text('No file edits to undo.')
      }
      const target = args.trim()
      let file: EditedFileInfo | undefined
      if (target) {
        file = files.find((f) => f.path === target || f.path.endsWith('/' + target))
        if (!file) {
          return text(
            `No edits tracked for: ${target}\nEdited files:\n${files.map((f) => '  ' + f.path).join('\n')}`,
          )
        }
      } else {
        file = files.slice().sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0))[0]
      }
      const versions = fh.getVersions(file.path)
      if (versions.length === 0) {
        return text(`No versions available for ${file.path}`)
      }
      const ok = fh.restoreOriginal(file.path)
      if (ok) {
        return text(
          `✓ Restored ${file.path} to original (pre-edit) state.\n  ${versions.length} version(s) were tracked.`,
        )
      }
      return text(`✗ Failed to restore ${file.path}. The backup may be missing.`)
    },
  },
  {
    name: 'diff',
    description: 'Show git diff (unstaged, staged, or full)',
    usage: '/diff [staged|full|stat]',
    handler: (args, ctx) => {
      const subcmd = args.trim().toLowerCase()
      try {
        let output: string
        if (subcmd === 'staged') {
          output = execSync('git diff --cached --stat', {
            cwd: ctx.cwd,
            encoding: 'utf8',
            timeout: 10000,
          }).trim()
          if (!output) return text('No staged changes.')
          return text(`Git diff (staged):\n\n${output}`)
        }
        if (subcmd === 'full') {
          output = execSync('git diff', { cwd: ctx.cwd, encoding: 'utf8', timeout: 10000 }).trim()
          if (!output) return text('No unstaged changes.')
          const lines = output.split('\n')
          if (lines.length > 200) {
            return text(
              `Git diff (unstaged, first 200 of ${lines.length} lines):\n\n${lines.slice(0, 200).join('\n')}\n... +${lines.length - 200} more lines (use /diff stat for summary)`,
            )
          }
          return text(`Git diff (unstaged):\n\n${output}`)
        }
        output = execSync('git diff --stat', {
          cwd: ctx.cwd,
          encoding: 'utf8',
          timeout: 10000,
        }).trim()
        if (!output) return text('No unstaged changes. Try /diff staged or /diff full')
        return text(
          `Git diff (unstaged):\n\n${output}\n\nUse /diff full for complete diff, /diff staged for staged changes.`,
        )
      } catch {
        return text('Not a git repository or git not available.')
      }
    },
  },
  {
    name: 'commit',
    description: 'Stage all changes and create a git commit',
    usage: '/commit <message>',
    handler: (args, ctx) => {
      if (!args.trim()) {
        return text('Usage: /commit <commit message>')
      }
      try {
        execFileSync('git', ['add', '-A'], { cwd: ctx.cwd, timeout: 10000 })
        execFileSync('git', ['commit', '-m', args], {
          cwd: ctx.cwd,
          encoding: 'utf8',
          timeout: 30000,
        })
        return text(`Committed: ${args}`)
      } catch (err) {
        return text(`Commit failed: ${(err as Error).message}`)
      }
    },
  },
  {
    name: 'git',
    description: 'Run git commands: /git status|log|stash|add|push|pull',
    usage: '/git <subcommand> [args]',
    handler: (args, ctx) => {
      const [subcmd, ...rest] = args.trim().split(/\s+/)
      const sub = (subcmd ?? '').toLowerCase()
      const safeRun = (cmd: string, params: string[], label: string): SlashCommandResult => {
        try {
          const out = execFileSync(cmd, params, {
            cwd: ctx.cwd,
            encoding: 'utf8',
            timeout: 15000,
          }).trim()
          return text(out ? `${label}:\n\n${out}` : `${label}: (no output)`)
        } catch (err) {
          return text(`${label} failed: ${(err as Error).message.slice(0, 200)}`)
        }
      }
      try {
        switch (sub) {
          case '':
          case 'status':
            return safeRun('git', ['status', '--short'], 'Git status')
          case 'log': {
            const n = rest[0] && /^\d+$/.test(rest[0]) ? rest[0] : '10'
            return safeRun('git', ['log', `--oneline`, `-${n}`, '--graph'], `Git log (last ${n})`)
          }
          case 'stash':
            if (rest[0] === 'pop' || rest[0] === 'apply') {
              return safeRun('git', ['stash', rest[0]], `Git stash ${rest[0]}`)
            }
            if (rest[0] === 'list') {
              return safeRun('git', ['stash', 'list'], 'Git stash list')
            }
            if (rest[0] === 'drop') {
              return safeRun('git', ['stash', 'drop', rest[1] ?? ''], 'Git stash drop')
            }
            return safeRun(
              'git',
              ['stash', 'push', '-m', rest.join(' ') || 'ovolv999 stash'],
              'Git stash',
            )
          case 'add':
            return safeRun('git', ['add', ...(rest.length > 0 ? rest : ['.'])], 'Git add')
          case 'push':
            return safeRun('git', ['push', ...rest], 'Git push')
          case 'pull':
            return safeRun('git', ['pull', ...rest], 'Git pull')
          case 'fetch':
            return safeRun('git', ['fetch', ...rest], 'Git fetch')
          case 'remote':
            return safeRun('git', ['remote', '-v'], 'Git remotes')
          case 'tag':
            if (rest.length === 0) {
              return safeRun('git', ['tag', '-l'], 'Git tags')
            }
            return safeRun('git', ['tag', ...rest], 'Git tag')
          default:
            return text(
              `Unknown git subcommand: ${sub}\nAvailable: status, log, stash, add, push, pull, fetch, remote, tag`,
            )
        }
      } catch {
        return text('Not a git repository or git not available.')
      }
    },
  },
  {
    name: 'init',
    description: 'Create OVOGO.md project config file',
    handler: (_args, ctx) => {
      const configPath = join(ctx.cwd, 'OVOGO.md')
      if (existsSync(configPath)) {
        return text(`OVOGO.md already exists at ${configPath}`)
      }
      const template = `# Project Instructions

## Overview
Describe your project here.

## Conventions
- Coding style and patterns
- Testing approach
- Build commands

## Important Notes
- Architecture decisions
- Known issues
- Security constraints
`
      writeFileSync(configPath, template, 'utf8')
      return text(`Created ${configPath} — edit it to add project-specific instructions.`)
    },
  },
  {
    name: 'review',
    description: 'Review code changes in the working directory',
    handler: (_args, _ctx) => {
      return {
        type: 'prompt',
        value:
          'Review all uncommitted changes in this repository. Analyze each modified file for bugs, security issues, performance problems, and convention violations. Group findings by severity: [CRITICAL] / [HIGH] / [MEDIUM] / [LOW]. Use git diff to see changes.',
      }
    },
  },
  {
    name: 'security-review',
    description: 'Run a security audit on the codebase',
    aliases: ['sec'],
    handler: (_args, _ctx) => {
      return {
        type: 'prompt',
        value:
          'Perform a comprehensive security review of this codebase. Check for: OWASP Top 10 vulnerabilities, injection risks (SQL/command/XSS), authentication/authorization issues, secrets/keys in code, insecure dependencies, input validation gaps, and unsafe file operations. Report findings with severity, location (file:line), and remediation steps.',
      }
    },
  },
  {
    name: 'branch',
    description: 'Show git branches or create a new one',
    usage: '/branch [name]  (no args = list branches)',
    handler: (args, ctx) => {
      try {
        if (args.trim()) {
          execFileSync('git', ['checkout', '-b', args.trim()], { cwd: ctx.cwd, timeout: 10000 })
          return text('Created and switched to branch: ' + args.trim())
        }
        const branches = execFileSync('git', ['branch', '-v'], {
          cwd: ctx.cwd,
          encoding: 'utf8',
          timeout: 10000,
        }).trim()
        return text('Git branches:\n' + branches)
      } catch {
        return text('Not a git repository or git not available.')
      }
    },
  },
  {
    name: 'files',
    description: 'Show files edited in this session',
    aliases: ['fl'],
    handler: (_args, ctx) => {
      const fh = ctx.engine.getFileHistory()
      if (!fh) return text('File history tracking not available.')
      return text(fh.getSummary())
    },
  },
  {
    name: 'diff-browser',
    aliases: ['difftree'],
    description: 'Browse changes as a structured file list. Usage: /diff-browser [n]',
    handler: async (args, ctx) => {
      const { getGitDiff, parseGitDiff, formatFileList, formatFileDetail } =
        await import('../ui/diffBrowser.js')
      const n = parseInt(args.trim(), 10)
      const diffOutput = getGitDiff(ctx.cwd)
      const diff = parseGitDiff(diffOutput)
      if (isNaN(n)) {
        return text(formatFileList(diff))
      }
      return text(formatFileDetail(diff, n - 1))
    },
  },
  {
    name: 'snapshot',
    aliases: ['snap', 'ws'],
    description:
      'Manage workspace snapshots. Usage: /snapshot [save|list|show|remove|add-file|add-todo|diff]',
    handler: async (args, ctx) => {
      const {
        createSnapshot,
        removeSnapshot,
        getSnapshot,
        listSnapshots,
        addFileToSnapshot,
        addTodoToSnapshot,
        toggleTodoInSnapshot,
        diffSnapshots,
        formatSnapshot,
        formatSnapshotList,
        formatSnapshotDiff,
      } = await import('../core/workspace.js')
      const parts = args.trim().split(/\s+/)
      const sub = parts[0] ?? 'list'
      if (sub === 'save' || sub === 'create') {
        const name = parts[1]
        if (!name) return text('Usage: /snapshot save <name> [notes...]')
        const notes = parts.slice(2).join(' ') || undefined
        const snap = createSnapshot(ctx.cwd, name, { notes })
        return text(`✓ Snapshot saved: ${snap.name} (id: ${snap.id})`)
      }
      if (sub === 'remove' || sub === 'rm') {
        const target = parts[1]
        if (!target) return text('Usage: /snapshot remove <id|name>')
        return text(removeSnapshot(ctx.cwd, target) ? '✓ Snapshot removed' : 'Snapshot not found')
      }
      if (sub === 'show') {
        const target = parts[1]
        if (!target) return text('Usage: /snapshot show <id|name>')
        const snap = getSnapshot(ctx.cwd, target)
        if (!snap) return text('Snapshot not found')
        return text(formatSnapshot(snap))
      }
      if (sub === 'add-file') {
        const target = parts[1]
        const file = parts[2]
        if (!target || !file) return text('Usage: /snapshot add-file <id|name> <path>')
        const snap = addFileToSnapshot(ctx.cwd, target, file)
        return snap ? text(`✓ Added ${file} to "${snap.name}"`) : text('Snapshot not found')
      }
      if (sub === 'add-todo') {
        const target = parts[1]
        const todo = parts.slice(2).join(' ')
        if (!target || !todo) return text('Usage: /snapshot add-todo <id|name> <text>')
        const snap = addTodoToSnapshot(ctx.cwd, target, todo)
        return snap ? text(`✓ Added todo to "${snap.name}"`) : text('Snapshot not found')
      }
      if (sub === 'toggle-todo') {
        const target = parts[1]
        const idx = parseInt(parts[2] ?? '', 10)
        if (!target || isNaN(idx)) return text('Usage: /snapshot toggle-todo <id|name> <index>')
        const snap = toggleTodoInSnapshot(ctx.cwd, target, idx)
        return snap
          ? text(`✓ Toggled todo ${idx} in "${snap.name}"`)
          : text('Snapshot or todo index not found')
      }
      if (sub === 'diff') {
        const [oldName, newName] = parts.slice(1)
        if (!oldName || !newName) return text('Usage: /snapshot diff <old> <new>')
        const old = getSnapshot(ctx.cwd, oldName)
        const cur = getSnapshot(ctx.cwd, newName)
        if (!old || !cur) return text('One or both snapshots not found')
        const diff = diffSnapshots(old, cur)
        return text(formatSnapshotDiff(diff, oldName, newName))
      }
      if (sub === 'list' || !sub) {
        const snaps = listSnapshots(ctx.cwd)
        return text(formatSnapshotList(snaps))
      }
      return text(`Usage: /snapshot [save|list|show|remove|add-file|add-todo|toggle-todo|diff]`)
    },
  },
]
