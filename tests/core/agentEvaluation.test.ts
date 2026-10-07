import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

interface EvaluationResult {
  taskId: string
  outcome: string
  checksPassed: boolean
  unrelatedChanges: string[]
  usage: string
  fixturePassed?: boolean
  inputTokens?: number
  outputTokens?: number
  interventionCount: number
  acceptancePassed: boolean
  toolCalls: Array<{ name: string }>
  recovery?: EvaluationResult
}
interface EvaluationReport {
  schemaVersion: number
  mode: string
  fixturePassed: boolean
  results: EvaluationResult[]
}
interface EvaluationApi {
  validateManifest: (input: unknown) => { tasks: Array<Record<string, unknown>> }
  evaluateResult: (input: Record<string, unknown>) => EvaluationResult
  runOfflineEvaluation: (options: { cliPath: string; outputDir: string; taskIds?: string[]; variant?: string }) => Promise<EvaluationReport>
  runProgram: (executable: string, args: string[], options: { cwd: string; timeout: number; maxOutputBytes?: number }) => Promise<{ code: number | null; timedOut: boolean; overflow: boolean; physicalSettlement: string; unfinishedResources: string[] }>
}

let api: Partial<EvaluationApi> = {}
let directory: string
let cliPath: string
let preserveEvidence = false
const root = resolve('.')
const exec = promisify(execFile)

beforeAll(async () => {
  api = await vi.importActual<EvaluationApi>('../../scripts/agent-eval.mjs')
})

afterAll(() => {
  if (directory) {
    expect(relative(join(root, '.artifacts'), directory).startsWith('..')).toBe(false)
    if (!preserveEvidence) rmSync(directory, { recursive: true, force: true })
  }
})

async function runtime(): Promise<string> {
  if (!directory) {
    mkdirSync(join(root, '.artifacts'), { recursive: true })
    directory = mkdtempSync(join(root, '.artifacts', 'evaluation-test-'))
  }
  if (process.env.OVOGO_EVAL_CLI_PATH) return resolve(process.env.OVOGO_EVAL_CLI_PATH)
  if (!cliPath) {
    const compiled = join(directory, 'compiled')
    await exec(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json', '--outDir', compiled], { cwd: root, timeout: 30_000, windowsHide: true })
    if (process.platform === 'win32') await exec(process.execPath, [join(root, 'native/execution-host/build.mjs'), join(compiled, 'native/execution-host/bin')], { cwd: root, timeout: 30_000, windowsHide: true })
    cliPath = join(compiled, 'bin/ovogogogo.js')
  }
  return cliPath
}

function observation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { taskId: 'sum-empty', revision: '71016d08156a5fda7633e5df6afa78788426faea', model: 'offline-coding-fixture-v1', outcome: 'completed', acceptancePassed: true, unrelatedChanges: [], durationMs: 1, usage: 'unknown', interventionCount: 0, toolCalls: [{ name: 'Read' }, { name: 'Edit' }, { name: 'Bash' }], toolChainPassed: true, exitCode: 0, ...overrides }
}

describe('coding evaluation verdicts', () => {
  it.each([1, -1, null, undefined])('rejects a completed claim when final process exit is %s', exitCode => {
    expect(api.evaluateResult!(observation({ exitCode })).checksPassed).toBe(false)
  })

  it.each(['timeout', 'overflow'])('bounds %s return when a descendant inherits output handles and retains unknown resources', async reason => {
    const script = "import { spawn } from 'node:child_process'; spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 3500)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }).unref(); " + (reason === 'overflow' ? "process.stdout.write('x'.repeat(4096)); " : '') + 'setInterval(() => {}, 1000)'
    const started = performance.now()
    const result = await api.runProgram!(process.execPath, ['--input-type=module', '-e', script], { cwd: root, timeout: reason === 'timeout' ? 200 : 5000, maxOutputBytes: reason === 'overflow' ? 128 : 1048576 })
    const elapsed = performance.now() - started
    await new Promise(resolveWait => setTimeout(resolveWait, 3600))
    expect(elapsed).toBeLessThan(1800)
    expect(result[reason === 'timeout' ? 'timedOut' : 'overflow']).toBe(true)
    expect(result.physicalSettlement).toBe('unconfirmed')
    expect(result.unfinishedResources.length).toBeGreaterThan(0)
  }, 10_000)

  it('accepts only a completed task with artifact and tool-chain evidence', () => {
    expect(api.evaluateResult!(observation()).checksPassed).toBe(true)
    expect(api.evaluateResult!(observation({ toolChainPassed: false })).checksPassed).toBe(false)
    expect(api.evaluateResult!(observation({ unfinishedResources: ['unsettled child'] })).checksPassed).toBe(false)
  })
  it('does not accept a success claim when independent artifact checks fail', () => {
    expect(api.evaluateResult).toBeTypeOf('function')
    expect(api.evaluateResult!(observation({ acceptancePassed: false, assistantText: 'Fixed and tested.' })).checksPassed).toBe(false)
  })

  it('reports unrelated writes separately and rejects them despite passing functional checks', () => {
    expect(api.evaluateResult).toBeTypeOf('function')
    const result = api.evaluateResult!(observation({ unrelatedChanges: ['sentinel.txt'] }))
    expect(result.acceptancePassed).toBe(true)
    expect(result.unrelatedChanges).toEqual(['sentinel.txt'])
    expect(result.checksPassed).toBe(false)
  })

  it.each(['cancelled', 'limit_reached', 'failed', 'blocked', 'needs_input'])('never records %s as a successful task', outcome => {
    expect(api.evaluateResult).toBeTypeOf('function')
    expect(api.evaluateResult!(observation({ outcome })).checksPassed).toBe(false)
  })

  it('does not invent zero usage when the provider supplies no billing usage', () => {
    expect(api.evaluateResult).toBeTypeOf('function')
    const result = api.evaluateResult!(observation())
    expect(result.usage).toBe('unknown')
    expect(result.inputTokens).toBeUndefined()
    expect(result.outputTokens).toBeUndefined()
  })

  it('validates twelve task contracts and refuses incomplete or out-of-scope manifests', () => {
    expect(api.validateManifest).toBeTypeOf('function')
    const manifest: unknown = JSON.parse(readFileSync(join(root, 'scripts/fixtures/coding-tasks/manifest.json'), 'utf8'))
    const valid = api.validateManifest!(manifest)
    expect(valid.tasks).toHaveLength(12)
    for (const field of ['baseCommit', 'prompt', 'acceptance', 'allowedPaths', 'budget']) {
      const broken = structuredClone(valid)
      delete broken.tasks[0][field]
      expect(() => api.validateManifest!(broken)).toThrow()
    }
    const escaped = structuredClone(valid)
    escaped.tasks[0].acceptance = '../outside.mjs'
    expect(() => api.validateManifest!(escaped)).toThrow()
  })

  it.each(['sum-empty', 'image-text'])('records broken %s CLI wiring as task failure and still saves a complete report', async taskId => {
    mkdirSync(join(root, '.artifacts'), { recursive: true })
    if (!directory) directory = mkdtempSync(join(root, '.artifacts', 'evaluation-test-'))
    const broken = join(directory, 'broken/bin/ovogogogo.js')
    mkdirSync(join(directory, 'broken/bin'), { recursive: true })
    writeFileSync(broken, "throw new Error('Fixture startup failure')\n")
    const outputDir = join(directory, 'broken-cli', taskId)
    const report = await api.runOfflineEvaluation!({ cliPath: broken, outputDir, taskIds: [taskId] })
    expect(report.results[0].outcome).toBe('failed')
    expect(report.fixturePassed).toBe(false)
    expect(report.results[0].checksPassed).toBe(false)
    expect(JSON.parse(readFileSync(join(outputDir, 'report.json'), 'utf8')).taskCount).toBe(1)
  }, 10_000)
})

describe('actual CLI offline coding evaluation', () => {
  it('counts the controlled cancellation as one intervention and keeps recovery separate', async () => {
    const cli = await runtime()
    const report = await api.runOfflineEvaluation!({ cliPath: cli, outputDir: join(directory, 'cancel-intervention'), taskIds: ['cancel-resume'] })
    expect(report.results[0].outcome).toBe('cancelled')
    expect(report.results[0].interventionCount).toBe(1)
    expect(report.results[0].recovery?.checksPassed).toBe(true)
  }, 30_000)

  it('runs twelve temporary git repositories with independent acceptance and actual tool receipts', async () => {
    expect(api.runOfflineEvaluation).toBeTypeOf('function')
    const cli = await runtime()
    const report = await api.runOfflineEvaluation!({ cliPath: cli, outputDir: join(directory, 'full') })
    preserveEvidence = !report.fixturePassed
    expect(report.schemaVersion).toBe(1)
    expect(report.mode).toBe('offline-fixture')
    expect(report.fixturePassed, JSON.stringify(report.results.filter(result => !result.fixturePassed))).toBe(true)
    expect(report.results).toHaveLength(12)
    expect(new Set(report.results.map(result => result.taskId)).size).toBe(12)
    for (const result of report.results) {
      const completed = result.recovery ?? result
      if (result.taskId === 'external-conflict') {
        expect(result.outcome).toBe('failed')
        expect(result.checksPassed).toBe(false)
        expect(result.acceptancePassed).toBe(true)
        expect(result.interventionCount).toBe(1)
      } else {
        expect(completed.checksPassed).toBe(true)
        expect(completed.toolCalls.map(call => call.name)).toEqual(expect.arrayContaining(['Read', 'Edit', 'Bash']))
      }
      expect(result.usage).toBe('unknown')
      expect(result.unrelatedChanges).toEqual([])
    }
    const cancelled = report.results.find(result => result.taskId === 'cancel-resume')!
    expect(cancelled.outcome).toBe('cancelled')
    expect(cancelled.checksPassed).toBe(false)
    expect(cancelled.recovery?.outcome).toBe('completed')
  }, 120_000)

  it.each(['claim-only', 'wrong-edit', 'unrelated-edit', 'limit'])('catches the %s agent fixture instead of trusting final text', async variant => {
    expect(api.runOfflineEvaluation).toBeTypeOf('function')
    const cli = await runtime()
    const report = await api.runOfflineEvaluation!({ cliPath: cli, outputDir: join(directory, variant), taskIds: ['sum-empty'], variant })
    const result = report.results[0]
    expect(result.checksPassed).toBe(false)
    expect(report.fixturePassed).toBe(false)
    if (variant === 'claim-only' || variant === 'wrong-edit') expect(result.acceptancePassed).toBe(false)
    if (variant === 'unrelated-edit') {
      expect(result.acceptancePassed).toBe(true)
      expect(result.unrelatedChanges).toEqual(['sentinel.txt'])
    }
    if (variant === 'limit') expect(result.outcome).toBe('limit_reached')
  }, 30_000)
})
