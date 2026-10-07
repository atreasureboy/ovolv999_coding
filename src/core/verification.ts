import { isManagedChild, spawnManaged, type ExecutionProfile } from './executionBackend.js'
import type { ExecutionPolicy } from './executionPolicy.js'
import { createHash } from 'crypto'
import { execFile } from 'child_process'
import { existsSync, readFileSync, createReadStream } from 'fs'
import { lstat, opendir, readlink } from 'fs/promises'
import { join, relative, resolve, sep } from 'path'
import type { VerificationCommandResult, VerificationEvidence } from './outcome.js'
import { quarantineWorkspace } from './runContext.js'

export type VerificationKind = 'compile' | 'lint' | 'unit' | 'integration' | 'task_acceptance'
export interface VerificationCheck { kind: VerificationKind; scope: string }

export interface VerificationPlan {
  checks: readonly VerificationCheck[]
  workspace: string
  commands: readonly string[]
  definitionHash: string
  excludedPaths: readonly string[]
}

function packageManagerCommand(cwd: string, script: string, packageManager?: string): string {
  const pm = packageManager?.split('@')[0]
  if (pm === 'bun' || existsSync(join(cwd, 'bun.lock')) || existsSync(join(cwd, 'bun.lockb'))) return `bun run ${script} 2>&1`
  if (pm === 'pnpm' || existsSync(join(cwd, 'pnpm-lock.yaml'))) return `pnpm run ${script} 2>&1`
  if (pm === 'yarn' || existsSync(join(cwd, 'yarn.lock'))) return `yarn ${script} 2>&1`
  return script === 'test' ? 'npm test 2>&1' : `npm run ${script} 2>&1`
}

export function detectVerifyCommands(cwd: string): string[] {
  const has = (name: string): boolean => existsSync(join(cwd, name))
  if (has('pyproject.toml') || has('setup.py') || has('requirements.txt')) return ['python -m compileall -q . 2>&1']
  if (has('go.mod')) return ['go vet ./... 2>&1']
  if (has('Cargo.toml')) return ['cargo check 2>&1']
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown>; packageManager?: string }
      const scripts = pkg.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts) ? pkg.scripts : {}
      const hasScript = (name: string): boolean => typeof scripts[name] === 'string' && Boolean(scripts[name]?.trim())
      const first = ['typecheck', 'tsc', 'build'].find(hasScript)
      const names = [first, hasScript('lint') ? 'lint' : undefined, hasScript('test') ? 'test' : undefined].filter((name): name is string => Boolean(name))
      if (names.length) return names.map(name => packageManagerCommand(cwd, name, pkg.packageManager))
    } catch { return has('tsconfig.json') ? ['npx tsc --noEmit 2>&1'] : [] }
  }
  return has('tsconfig.json') ? ['npx tsc --noEmit 2>&1'] : []
}

function definitionHash(cwd: string, commands: readonly string[], excludedPaths: readonly string[], checks: readonly VerificationCheck[]): string {
  const hash = createHash('sha256').update(JSON.stringify({ commands, excludedPaths, checks }))
  for (const name of ['package.json', 'pyproject.toml', 'setup.py', 'requirements.txt', 'go.mod', 'Cargo.toml', 'tsconfig.json']) {
    hash.update(name)
    if (existsSync(join(cwd, name))) hash.update(readFileSync(join(cwd, name)))
  }
  return hash.digest('hex')
}

export function createVerificationPlan(cwd: string, commands: readonly string[] = detectVerifyCommands(cwd), runtimePaths: readonly string[] = [], kinds?: readonly VerificationCheck[]): VerificationPlan {
  const workspace = resolve(cwd)
  const excludedPaths = [...new Set(runtimePaths.map(path => resolve(path)).filter(path => path.startsWith(workspace + sep)))].sort()
  const checks = commands.map((command, index) => Object.freeze<VerificationCheck>(kinds?.[index] ?? { kind: /(?:compileall|cargo check|go vet|tsc|typecheck|run build)/.test(command) ? 'compile' : /lint/.test(command) ? 'lint' : /test|pytest|vitest/.test(command) ? 'unit' : 'task_acceptance', scope: 'workspace' }))
  return Object.freeze({ checks: Object.freeze(checks), workspace, commands: Object.freeze([...commands]), excludedPaths: Object.freeze(excludedPaths), definitionHash: definitionHash(cwd, commands, excludedPaths, checks) })
}

const excludedDirectories = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.artifacts', '.loop', '.ovogo', '__pycache__', '.pytest_cache', 'target'])
const excludedFiles = new Set(['ovogo_progress.json', 'agent_events.ndjson'])

export interface ArtifactScanOptions {
  signal?: AbortSignal
  maxFiles?: number
  maxBytes?: number
  timeoutMs?: number
  concurrency?: number
  onMetrics?: (metrics: { files: number; bytes: number; durationMs: number }) => void
}

export async function captureArtifactVersion(cwd: string, excludedPaths: readonly string[] = [], options: ArtifactScanOptions = {}): Promise<string> {
  const started = Date.now()
  const budget = { maxFiles: options.maxFiles ?? 100_000, maxBytes: options.maxBytes ?? 2 * 1024 ** 3, timeoutMs: options.timeoutMs ?? 30_000, concurrency: options.concurrency ?? 4 }
  for (const value of Object.values(budget)) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid artifact scan budget')
  const timeout = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal
  const timer = setTimeout(() => timeout.abort(new Error('Artifact scan time budget exceeded')), budget.timeoutMs)
  let bytes = 0
  let filesRead = 0
  let visited = 0
  try {
    signal.throwIfAborted()
    const hash = createHash('sha256').update(resolve(cwd))
    if (!existsSync(cwd)) return hash.update('missing-workspace').digest('hex')
    const inventory = await new Promise<Array<{ name: string; tracked: boolean }> | undefined>((resolveInventory, reject) => {
      execFile('git', ['ls-files', '-t', '-z', '--cached', '--others', '--exclude-standard'], { cwd, signal, encoding: 'utf8', timeout: Math.min(5000, budget.timeoutMs), maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
        if (signal.aborted) reject(signal.reason instanceof Error ? signal.reason : new Error('Artifact scan cancelled'))
        else if (error && !/not a git repository/i.test(String((error as Error & { stderr?: string }).stderr ?? error.message)) && (error as NodeJS.ErrnoException).code !== 'ENOENT') reject(new Error(error.message, { cause: error }))
        else resolveInventory(error ? undefined : stdout.split('\0').filter(Boolean).map(entry => ({ name: entry.slice(2), tracked: entry[0] !== '?' })))
      })
    })
    const excluded = (path: string): boolean => excludedPaths.some(entry => path === resolve(entry) || path.startsWith(resolve(entry) + sep))
    const names = new Set<string>()
    const add = (name: string): void => {
      names.add(name.replaceAll('\\', '/'))
      if (names.size > budget.maxFiles) throw new Error('Artifact file budget exceeded')
    }
    for (const file of inventory ?? []) if (file.tracked || !file.name.split(/[\\/]/).some(part => excludedDirectories.has(part) || excludedFiles.has(part))) add(file.name)
    async function collect(dir: string): Promise<void> {
      signal.throwIfAborted()
      for await (const entry of await opendir(dir)) {
        signal.throwIfAborted()
        if (++visited > budget.maxFiles * 2) throw new Error('Artifact traversal budget exceeded')
        if (excludedDirectories.has(entry.name) || excludedFiles.has(entry.name)) continue
        const path = join(dir, entry.name)
        if (excluded(path)) continue
        if (entry.isDirectory()) await collect(path)
        else add(relative(cwd, path))
      }
    }
    await collect(cwd)
    const ordered = [...names].sort()
    const digests: string[] = Array.from({ length: ordered.length }, () => '')
    let cursor = 0
    await Promise.all(Array.from({ length: Math.min(budget.concurrency, ordered.length) }, async () => {
      for (;;) {
        const index = cursor++
        if (index >= ordered.length) return
        signal.throwIfAborted()
        const name = ordered[index]
        const path = resolve(cwd, name)
        if (excluded(path)) { digests[index] = ''; continue }
        const fileHash = createHash('sha256').update(name).update('\0')
        try {
          const before = await lstat(path)
          fileHash.update(String(before.mode))
          if (before.isSymbolicLink()) fileHash.update(await readlink(path))
          else if (before.isFile()) {
            if (bytes + before.size > budget.maxBytes) throw new Error('Artifact byte budget exceeded')
            filesRead++
            for await (const chunk of createReadStream(path, { signal, highWaterMark: 64 * 1024 })) {
              bytes += (chunk as Buffer).length
              if (bytes > budget.maxBytes) throw new Error('Artifact byte budget exceeded')
              fileHash.update(chunk as Buffer)
            }
            const after = await lstat(path)
            if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error('Artifact changed during hashing; scan invalidated')
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          fileHash.update('deleted')
        }
        digests[index] = fileHash.digest('hex')
      }
    }))
    signal.throwIfAborted()
    return hash.update(digests.join('\0')).digest('hex')
  } finally {
    clearTimeout(timer)
    timeout.abort()
    options.onMetrics?.({ files: filesRead, bytes, durationMs: Date.now() - started })
  }
}

export function runVerificationCommand(command: string, cwd: string, signal?: AbortSignal, timeoutMs = 60_000, profile?: ExecutionProfile, policy?: ExecutionPolicy): Promise<VerificationCommandResult> {
  return executeCommand(command, cwd, signal, timeoutMs, undefined, profile, policy)
}

export function runFileVerificationCommand(executable: string, args: readonly string[], cwd: string, signal?: AbortSignal, timeoutMs = 60_000, policy?: ExecutionPolicy): Promise<VerificationCommandResult> {
  return executeCommand([executable, ...args].join(' '), cwd, signal, timeoutMs, { executable, args }, undefined, policy)
}

async function executeCommand(command: string, cwd: string, signal: AbortSignal | undefined, timeoutMs: number, direct?: { executable: string; args: readonly string[] }, profile?: ExecutionProfile, policy?: ExecutionPolicy): Promise<VerificationCommandResult> {
  if (signal?.aborted) return { command, passed: false, output: 'Cancelled before verification', exitCode: null, cancelled: true }
  return new Promise(resolveResult => {
    const child = spawnManaged(direct?.executable ?? command, direct?.args ?? [], { cwd, profile, policy, shell: !direct, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let cancelled = false
    let timedOut = false
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let closeTimer: ReturnType<typeof setTimeout> | undefined
    let resolveClosed!: () => void
    const closed = new Promise<void>(resolveClose => { resolveClosed = resolveClose })
    let unfinishedResources: string[] | undefined
    const append = (value: Buffer): void => { output = (output + value.toString()).slice(-16_384) }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    const finish = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      if (closeTimer) clearTimeout(closeTimer)
      signal?.removeEventListener('abort', abort)
      resolveResult({ command, passed: exitCode === 0 && !cancelled && !timedOut, output: output.trim(), exitCode, cancelled, timedOut, unfinishedResources })
    }
    const kill = (force: boolean): void => {
      if (isManagedChild(child)) { child.kill(force ? 'SIGKILL' : 'SIGTERM'); return }
      if (!child.pid) return
      if (process.platform === 'win32') {
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 2000 }, (error) => {
          if (error) output += `\nProcess tree termination failed: ${error.message}`
        })
      } else {
        try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM') } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') output += `\nProcess group termination failed: ${(error as Error).message}`
        }
      }
    }
    const stop = (): void => {
      kill(true)
      killTimer = setTimeout(() => kill(true), 250)
      closeTimer = setTimeout(() => {
        output += '\nVerification process did not confirm termination; workspace must remain blocked.'
        unfinishedResources = [`verification process ${child.pid ?? 'unknown'}`]
        quarantineWorkspace(cwd, closed)
        child.stdout?.destroy()
        child.stderr?.destroy()
        child.unref()
        finish(null)
      }, 2500)
    }
    const abort = (): void => { cancelled = true; stop() }
    const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    child.once('error', error => {
      output += error.message
      if (isManagedChild(child) && child.physicalState !== 'settled') {
        unfinishedResources = [`verification process ${child.pid ?? 'unknown'}`]
        quarantineWorkspace(cwd, child.physicallySettled)
      } else resolveClosed()
      finish(null)
    })
    child.once('close', code => { resolveClosed(); finish(code) })
    if (signal?.aborted) abort()
  })
}

export async function executeVerification(options: { cwd: string; plan?: VerificationPlan; signal?: AbortSignal; runId?: string; artifactVersion?: string; timeoutMs?: number; executionProfile?: ExecutionProfile; executionPolicy?: ExecutionPolicy }): Promise<VerificationEvidence> {
  const { cwd, signal, runId, timeoutMs } = options
  const plan = options.plan ?? createVerificationPlan(cwd)
  const artifactVersion = options.artifactVersion ?? await captureArtifactVersion(cwd, plan.excludedPaths, { signal })
  const evidence: VerificationEvidence = { status: 'not_run', workspace: resolve(cwd), artifactVersion, definitionHash: plan.definitionHash, runId, commands: [], output: '', sufficientForCompletion: plan.checks.some(check => ['unit', 'integration', 'task_acceptance'].includes(check.kind)) }
  if (plan.workspace !== resolve(cwd) || definitionHash(cwd, plan.commands, plan.excludedPaths, plan.checks) !== plan.definitionHash) {
    return { ...evidence, status: 'failed', output: 'Frozen verification definition or workspace changed during execution.' }
  }
  if (signal?.aborted) return { ...evidence, output: 'Verification cancelled.' }
  if (artifactVersion !== await captureArtifactVersion(cwd, plan.excludedPaths, { signal })) return { ...evidence, status: 'failed', output: 'Artifact changed before verification began.' }
  if (!plan.commands.length) return { ...evidence, status: 'not_applicable', output: 'No executable project verification checks were discovered.' }
  for (const [index, command] of plan.commands.entries()) {
    const result = await runVerificationCommand(command, cwd, signal, timeoutMs, options.executionProfile, options.executionPolicy)
    evidence.commands.push({ ...result, ...plan.checks[index] })
    if (result.cancelled || result.timedOut) break
  }
  evidence.status = evidence.commands.length === plan.commands.length && evidence.commands.every(command => command.passed) ? 'passed' : 'failed'
  evidence.output = evidence.commands.map(command => `${command.passed ? 'PASS' : 'FAILED'} ${command.command}\n${command.output}`).join('\n\n')
  evidence.unfinishedResources = evidence.commands.flatMap(command => command.unfinishedResources ?? [])
  if (signal?.aborted) return { ...evidence, status: 'failed', output: evidence.output + '\nVerification cancelled; acceptance was not completed.' }
  if (artifactVersion !== await captureArtifactVersion(cwd, plan.excludedPaths, { signal }) || definitionHash(cwd, plan.commands, plan.excludedPaths, plan.checks) !== plan.definitionHash) {
    evidence.status = 'failed'
    evidence.output += '\nArtifact or acceptance definition changed during verification; evidence is stale.'
  }
  return evidence
}
