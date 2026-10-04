import type * as ChildProcessModule from 'node:child_process'
import type { ExecFileOptions } from 'node:child_process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createProcessScope } from '../../src/core/executionBackend.js'
import { resolveExecutionPolicy } from '../../src/core/executionPolicy.js'
import { GrepTool } from '../../src/tools/grep.js'

const transport = vi.hoisted(() => ({
  execFile:
    vi.fn<
      (
        command: string,
        args: string[],
        options: ExecFileOptions,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => void
    >(),
}))
vi.mock('child_process', async (importOriginal) => {
  const { promisify } = await import('node:util')
  Object.defineProperty(transport.execFile, promisify.custom, {
    value: (command: string, args: string[], options: ExecFileOptions) =>
      new Promise<{ stdout: string; stderr: string }>((resolve, reject) =>
        transport.execFile(
          command,
          args,
          options,
          (error: Error | null, stdout: string, stderr: string) =>
            error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }),
        ),
      ),
  })
  return { ...(await importOriginal<typeof ChildProcessModule>()), ...transport }
})

beforeEach(() => {
  transport.execFile.mockImplementation(
    (
      command: string,
      _args: string[],
      options: ExecFileOptions,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      queueMicrotask(() =>
        callback(
          command === 'rg'
            ? Object.assign(new Error('Executable absent'), { code: 'ENOENT' })
            : null,
          `credential-present:${Boolean(options.env?.OVO_TEST_SECRET_TOKEN)}`,
          '',
        ),
      )
    },
  )
})

afterEach(() => {
  transport.execFile.mockReset()
  vi.unstubAllEnvs()
})

it('keeps ambient credentials out of both the preferred search and its executable fallback', async () => {
  vi.stubEnv('OVO_TEST_SECRET_TOKEN', 'offline-search-credential')
  const result = await new GrepTool().execute(
    { pattern: 'needle', output_mode: 'content' },
    { cwd: process.cwd(), permissionMode: 'auto' },
  )
  expect(result.isError).toBe(false)
  expect(result.content).toContain('credential-present:false')
  expect(transport.execFile.mock.calls.map((call) => call[0])).toEqual(['rg', 'grep'])
})

it('refuses direct search when its context requests unavailable isolation', async () => {
  const result = await new GrepTool().execute(
    { pattern: 'needle' },
    {
      cwd: process.cwd(),
      permissionMode: 'auto',
      executionPolicy: resolveExecutionPolicy({ mode: 'isolated-worker' }, process.cwd()),
    },
  )
  expect(result.isError).toBe(true)
  expect(result.content).toMatch(/isolation.*unavailable|refused/i)
  expect(transport.execFile).not.toHaveBeenCalled()
})

it('refuses a trusted search beneath an unsupported ancestor scope', async () => {
  const trusted = resolveExecutionPolicy(undefined, process.cwd())
  const isolated = resolveExecutionPolicy({ mode: 'isolated-worker' }, process.cwd())
  const result = await createProcessScope(undefined, isolated).run(() =>
    createProcessScope(undefined, trusted).run(() =>
      new GrepTool().execute(
        { pattern: 'needle' },
        { cwd: process.cwd(), permissionMode: 'auto', executionPolicy: trusted },
      ),
    ),
  )
  expect(result.isError).toBe(true)
  expect(transport.execFile).not.toHaveBeenCalled()
})
