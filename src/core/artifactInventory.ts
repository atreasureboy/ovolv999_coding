import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, createReadStream } from 'node:fs'
import { lstat, opendir, readlink } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { createLoopArtifactPolicy, isLoopRuntimeArtifact, type LoopArtifactPolicy } from './artifactPolicy.js'

const excludedDirectories = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.artifacts', '.loop', '.ovogo', '__pycache__', '.pytest_cache', 'target'])
const excludedFiles = new Set(['ovogo_progress.json', 'agent_events.ndjson'])

export interface ArtifactScanOptions {
  artifactPolicy?: LoopArtifactPolicy
  signal?: AbortSignal
  maxFiles?: number
  maxBytes?: number
  timeoutMs?: number
  concurrency?: number
  onMetrics?: (metrics: { files: number; bytes: number; durationMs: number }) => void
}

export async function captureArtifactVersion(cwd: string, excludedPaths: readonly string[] = [], options: ArtifactScanOptions = {}): Promise<string> {
  const started = Date.now()
  const policy = options.artifactPolicy ? createLoopArtifactPolicy(options.artifactPolicy) : undefined
  if (policy && createLoopArtifactPolicy({ ...policy, workspace: cwd }).workspace !== policy.workspace) throw new Error('Artifact policy workspace mismatch')
  const directories = policy ? new Set([...excludedDirectories].filter(name => name !== '.loop' && name !== '.ovogo')) : excludedDirectories
  const files = policy ? new Set<string>() : excludedFiles
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
    const hash = createHash('sha256').update(policy?.workspace ?? resolve(cwd))
    if (!existsSync(cwd)) return hash.update('missing-workspace').digest('hex')
    const inventory = await new Promise<Array<{ name: string; tracked: boolean }> | undefined>((resolveInventory, reject) => {
      execFile('git', ['ls-files', '-t', '-z', '--cached', '--others', '--exclude-standard'], { cwd, signal, encoding: 'utf8', timeout: Math.min(5000, budget.timeoutMs), maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
        if (signal.aborted) reject(signal.reason instanceof Error ? signal.reason : new Error('Artifact scan cancelled'))
        else if (error && !/not a git repository/i.test(String((error as Error & { stderr?: string }).stderr ?? error.message)) && (error as NodeJS.ErrnoException).code !== 'ENOENT') reject(new Error(error.message, { cause: error }))
        else resolveInventory(error ? undefined : stdout.split('\0').filter(Boolean).map(entry => ({ name: entry.slice(2), tracked: entry[0] !== '?' })))
      })
    })
    const excluded = (path: string): boolean => policy ? isLoopRuntimeArtifact(path, policy) : excludedPaths.some(entry => path === resolve(entry) || path.startsWith(resolve(entry) + sep))
    const names = new Set<string>()
    const add = (name: string): void => {
      names.add(name.replaceAll('\\', '/'))
      if (names.size > budget.maxFiles) throw new Error('Artifact file budget exceeded')
    }
    for (const file of inventory ?? []) if ((!policy || !excluded(resolve(cwd, file.name))) && (file.tracked || !file.name.split(/[\\/]/).some(part => directories.has(part) || files.has(part)))) add(file.name)
    async function collect(dir: string): Promise<void> {
      signal.throwIfAborted()
      for await (const entry of await opendir(dir)) {
        signal.throwIfAborted()
        if (++visited > budget.maxFiles * 2) throw new Error('Artifact traversal budget exceeded')
        if (directories.has(entry.name) || files.has(entry.name)) continue
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
    return hash.update((policy ? digests.filter(Boolean) : digests).join('\0')).digest('hex')
  } finally {
    clearTimeout(timer)
    timeout.abort()
    options.onMetrics?.({ files: filesRead, bytes, durationMs: Date.now() - started })
  }
}
