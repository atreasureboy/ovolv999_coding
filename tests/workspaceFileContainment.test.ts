import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { FileReadTool } from '../src/tools/fileRead.js'
import { FileWriteTool } from '../src/tools/fileWrite.js'
import { FileEditTool } from '../src/tools/fileEdit.js'
import { NotebookEditTool } from '../src/tools/notebookEdit.js'
import { BashTool } from '../src/tools/bash.js'
import { FileReadState } from '../src/core/fileState.js'
import type { Tool, ToolContext } from '../src/core/types.js'

let root: string
let child: string
let outside: string
let context: ToolContext
const notebook = JSON.stringify({ nbformat: 4, nbformat_minor: 5, cells: [{ cell_type: 'code', source: 'original', metadata: {} }] })
const cases: Array<[string, Tool, string, (path: string) => Record<string, unknown>]> = [
  ['Read', new FileReadTool(), 'data.txt', file_path => ({ file_path })],
  ['Write', new FileWriteTool(), 'data.txt', file_path => ({ file_path, content: 'changed' })],
  ['Edit', new FileEditTool(), 'data.txt', file_path => ({ file_path, old_string: 'original', new_string: 'changed' })],
  ['NotebookEdit', new NotebookEditTool(), 'data.ipynb', notebook_path => ({ notebook_path, cell_id: '0', new_source: 'changed' })],
]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'workspace-file-boundary-'))
  child = join(root, 'child')
  outside = join(root, 'child-sibling')
  mkdirSync(child)
  mkdirSync(outside)
  writeFileSync(join(outside, 'data.txt'), 'original')
  writeFileSync(join(outside, 'data.ipynb'), notebook)
  context = { cwd: child, permissionMode: 'auto', workspace: { cwd: child, worktreeName: 'child' }, fileState: new FileReadState() }
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('bound native file tools', () => {
  for (const [name, tool, file, input] of cases) {
    it.each(['absolute', 'parent', 'symlink'])(`${name} refuses %s workspace escape before reading or changing the file`, async kind => {
      const target = join(outside, file)
      context.fileState!.markFileRead(target, file.endsWith('.ipynb') ? notebook : 'original')
      let supplied = target
      if (kind === 'parent') supplied = join('..', 'child-sibling', file)
      if (kind === 'symlink') {
        symlinkSync(outside, join(child, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
        supplied = join('linked', file)
        context.fileState!.markFileRead(join(child, supplied), file.endsWith('.ipynb') ? notebook : 'original')
      }
      const result = await tool.execute(input(supplied), context)
      expect(result.isError).toBe(true)
      expect(result.content).toMatch(/outside.*workspace/i)
      expect(readFileSync(target, 'utf8')).toBe(file.endsWith('.ipynb') ? notebook : 'original')
      if (name === 'Read') expect(result.content).not.toContain('original')
    })

    it(`${name} preserves unbound main absolute path access`, async () => {
      const target = join(outside, file)
      context.workspace = undefined
      context.fileState!.markFileRead(target, file.endsWith('.ipynb') ? notebook : 'original')
      expect((await tool.execute(input(target), context)).isError).toBe(false)
    })
  }

  it('rejects a new file through a linked existing ancestor', async () => {
    symlinkSync(outside, join(child, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const result = await new FileWriteTool().execute({ file_path: 'linked/new/nested.txt', content: 'changed' }, context)
    expect(result.isError).toBe(true)
    expect(existsSync(join(outside, 'new'))).toBe(false)
  })

  it('confines a delegated shared-workspace child without a named worktree', async () => {
    context.workspace = { cwd: child }
    context.parentRunId = 'parent-run'
    const result = await new FileWriteTool().execute({ file_path: join(outside, 'new.txt'), content: 'changed' }, context)
    expect(result.isError).toBe(true)
    expect(existsSync(join(outside, 'new.txt'))).toBe(false)
  })

  it('enforces the delegated effective configuration marker without parent metadata', async () => {
    context.workspace = undefined
    context.workspaceBound = true
    const result = await new FileWriteTool().execute({ file_path: join(outside, 'new.txt'), content: 'changed' }, context)
    expect(result.isError).toBe(true)
    expect(existsSync(join(outside, 'new.txt'))).toBe(false)
  })

  it('allows a canonical internal link through Read then Edit', async () => {
    mkdirSync(join(child, 'real'))
    writeFileSync(join(child, 'real/data.txt'), 'original')
    symlinkSync(join(child, 'real'), join(child, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    expect((await new FileReadTool().execute({ file_path: 'linked/data.txt' }, context)).isError).toBe(false)
    expect((await new FileEditTool().execute({ file_path: 'real/data.txt', old_string: 'original', new_string: 'changed' }, context)).isError).toBe(false)
    expect(readFileSync(join(child, 'real/data.txt'), 'utf8')).toBe('changed')
  })

  it('uses the bound workspace even when legacy cwd differs and permits missing descendants', async () => {
    context.cwd = outside
    const result = await new FileWriteTool().execute({ file_path: 'new/nested.txt', content: 'changed' }, context)
    expect(result.isError).toBe(false)
    expect(readFileSync(join(child, 'new/nested.txt'), 'utf8')).toBe('changed')
    expect(existsSync(join(outside, 'new'))).toBe(false)
  })
})

describe('Bash resource classification', () => {
  it('holds a write lease for git diff output that really creates a file', () => {
    execFileSync('git', ['init', '-q', child])
    writeFileSync(join(child, 'tracked.txt'), 'original')
    execFileSync('git', ['add', 'tracked.txt'], { cwd: child })
    writeFileSync(join(child, 'tracked.txt'), 'changed')
    execFileSync('git', ['diff', '--output=diff.patch'], { cwd: child })
    expect(readFileSync(join(child, 'diff.patch'), 'utf8')).toContain('+changed')
    expect(new BashTool().isConcurrencySafe({ command: 'git diff --output=diff.patch' })).toBe(false)
  })

  it.each(['git log --output=log.txt', 'git diff --output diff.patch', 'rg --pre processor pattern file', 'rg --pr=processor pattern file', 'fd --exec touch generated', 'date --set=2026-01-01', 'file -C', 'npx tsc --noEmit --incremental', 'git diff --ext-diff', 'git log --unknown-option'])('serializes uncertain or mutating options: %s', command => {
    expect(new BashTool().isConcurrencySafe({ command })).toBe(false)
  })

  it.each(['ls', 'cat data.txt', 'git status --short', 'git branch --show-current', 'rg --no-config --line-number pattern .'])('keeps known read queries concurrent: %s', command => {
    expect(new BashTool().isConcurrencySafe({ command })).toBe(true)
  })
})
