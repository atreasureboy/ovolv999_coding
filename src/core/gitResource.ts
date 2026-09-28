import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { promisify } from 'util'
import { withWorkspaceAccess } from './runContext.js'

const execute = promisify(execFile)

export async function withGitResource<T>(cwd: string, signal: AbortSignal | undefined, operation: () => Promise<T>, write = true): Promise<T> {
  const activeSignal = signal ?? new AbortController().signal
  activeSignal.throwIfAborted()
  let commonDirectory: string
  try {
    const result = await execute('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd, encoding: 'utf8', timeout: 10_000, windowsHide: true, signal: activeSignal,
    })
    commonDirectory = result.stdout.trimEnd()
  } catch (error) {
    activeSignal.throwIfAborted()
    const failure = error as NodeJS.ErrnoException & { stderr?: string }
    if (failure.code === 'ENOENT' || /not a git repository/i.test(failure.stderr ?? '')) return operation()
    throw error
  }
  return withWorkspaceAccess(commonDirectory, randomUUID(), write, activeSignal, operation)
}
