import { createHash } from 'crypto'
import { execFile, spawn } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { lstat, readFile, readdir, readlink } from 'fs/promises'
import { join, relative, resolve, sep } from 'path'
import type { VerificationCommandResult, VerificationEvidence } from './outcome.js'
import { quarantineWorkspace } from './runContext.js'

export interface VerificationPlan {
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

function definitionHash(cwd: string, commands: readonly string[], excludedPaths: readonly string[]): string {
  const hash = createHash('sha256').update(JSON.stringify({ commands, excludedPaths }))
  for (const name of ['package.json', 'pyproject.toml', 'setup.py', 'requirements.txt', 'go.mod', 'Cargo.toml', 'tsconfig.json']) {
    hash.update(name)
    if (existsSync(join(cwd, name))) hash.update(readFileSync(join(cwd, name)))
  }
  return hash.digest('hex')
}

export function createVerificationPlan(cwd: string, commands: readonly string[] = detectVerifyCommands(cwd), runtimePaths: readonly string[] = []): VerificationPlan {
  const workspace = resolve(cwd)
  const excludedPaths = [...new Set(runtimePaths.map(path => resolve(path)).filter(path => path.startsWith(workspace + sep)))].sort()
  return Object.freeze({ workspace, commands: Object.freeze([...commands]), excludedPaths: Object.freeze(excludedPaths), definitionHash: definitionHash(cwd, commands, excludedPaths) })
}

const excludedDirectories = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.artifacts', '.loop', '.ovogo', '__pycache__', '.pytest_cache', 'target'])
const excludedFiles = new Set(['ovogo_progress.json', 'agent_events.ndjson'])

export async function captureArtifactVersion(cwd: string, excludedPaths: readonly string[] = []): Promise<string> {
  const hash = createHash('sha256').update(resolve(cwd))
  const inventory = await new Promise<Array<{ name: string; tracked: boolean }> | undefined>(resolveInventory => {
    execFile('git', ['ls-files', '-t', '-z', '--cached', '--others', '--exclude-standard'], { cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      resolveInventory(error ? undefined : stdout.split('\0').filter(Boolean).map(entry => ({ name: entry.slice(2), tracked: entry[0] !== '?' })))
    })
  })
  const excluded = (path: string): boolean => excludedPaths.some(entry => path === resolve(entry) || path.startsWith(resolve(entry) + sep))
  async function collect(dir: string): Promise<string[]> {
    const result: string[] = []
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (excludedDirectories.has(entry.name) || excludedFiles.has(entry.name)) continue
      const path = join(dir, entry.name)
      if (excluded(path)) continue
      if (entry.isDirectory()) result.push(...await collect(path))
      else result.push(relative(cwd, path))
    }
    return result
  }
  if (!existsSync(cwd)) return hash.update('missing-workspace').digest('hex')
  const files = [...(inventory ?? []), ...(await collect(cwd)).map(name => ({ name, tracked: false }))]
  const tracked = new Set(files.filter(file => file.tracked).map(file => file.name))
  for (const name of [...new Set(files.map(file => file.name))].sort()) {
    if (!tracked.has(name) && name.split(/[\\/]/).some(part => excludedDirectories.has(part) || excludedFiles.has(part))) continue
    const path = resolve(cwd, name)
    if (excluded(path)) continue
    hash.update(name).update('\0')
    try {
      const stat = await lstat(path)
      hash.update(String(stat.mode))
      if (stat.isSymbolicLink()) hash.update(await readlink(path))
      else if (stat.isFile()) hash.update(await readFile(path))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      hash.update('deleted')
    }
  }
  return hash.digest('hex')
}

export function runVerificationCommand(command: string, cwd: string, signal?: AbortSignal, timeoutMs = 60_000): Promise<VerificationCommandResult> {
  return executeCommand(command, cwd, signal, timeoutMs)
}

export function runFileVerificationCommand(executable: string, args: readonly string[], cwd: string, signal?: AbortSignal, timeoutMs = 60_000): Promise<VerificationCommandResult> {
  return executeCommand([executable, ...args].join(' '), cwd, signal, timeoutMs, { executable, args })
}

async function executeCommand(command: string, cwd: string, signal: AbortSignal | undefined, timeoutMs: number, direct?: { executable: string; args: readonly string[] }): Promise<VerificationCommandResult> {
  if (signal?.aborted) return { command, passed: false, output: 'Cancelled before verification', exitCode: null, cancelled: true }
  return new Promise(resolveResult => {
    const child = spawn(direct?.executable ?? command, direct?.args ?? [], { cwd, shell: !direct, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
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
    child.once('error', error => { output += error.message; resolveClosed(); finish(null) })
    child.once('close', code => { resolveClosed(); finish(code) })
    if (signal?.aborted) abort()
  })
}

export async function executeVerification(options: { cwd: string; plan?: VerificationPlan; signal?: AbortSignal; runId?: string; artifactVersion?: string; timeoutMs?: number }): Promise<VerificationEvidence> {
  const { cwd, signal, runId, timeoutMs } = options
  const plan = options.plan ?? createVerificationPlan(cwd)
  const artifactVersion = options.artifactVersion ?? await captureArtifactVersion(cwd, plan.excludedPaths)
  const evidence: VerificationEvidence = { status: 'not_run', workspace: resolve(cwd), artifactVersion, definitionHash: plan.definitionHash, runId, commands: [], output: '' }
  if (plan.workspace !== resolve(cwd) || definitionHash(cwd, plan.commands, plan.excludedPaths) !== plan.definitionHash) {
    return { ...evidence, status: 'failed', output: 'Frozen verification definition or workspace changed during execution.' }
  }
  if (signal?.aborted) return { ...evidence, output: 'Verification cancelled.' }
  if (artifactVersion !== await captureArtifactVersion(cwd, plan.excludedPaths)) return { ...evidence, status: 'failed', output: 'Artifact changed before verification began.' }
  if (!plan.commands.length) return { ...evidence, status: 'not_applicable', output: 'No executable project verification checks were discovered.' }
  for (const command of plan.commands) {
    const result = await runVerificationCommand(command, cwd, signal, timeoutMs)
    evidence.commands.push(result)
    if (result.cancelled || result.timedOut) break
  }
  evidence.status = evidence.commands.length === plan.commands.length && evidence.commands.every(command => command.passed) ? 'passed' : 'failed'
  evidence.output = evidence.commands.map(command => `${command.passed ? 'PASS' : 'FAILED'} ${command.command}\n${command.output}`).join('\n\n')
  evidence.unfinishedResources = evidence.commands.flatMap(command => command.unfinishedResources ?? [])
  if (artifactVersion !== await captureArtifactVersion(cwd, plan.excludedPaths) || definitionHash(cwd, plan.commands, plan.excludedPaths) !== plan.definitionHash) {
    evidence.status = 'failed'
    evidence.output += '\nArtifact or acceptance definition changed during verification; evidence is stale.'
  }
  return evidence
}
