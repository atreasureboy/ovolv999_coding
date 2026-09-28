import { spawn } from 'node:child_process'
import { mkdirSync, appendFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = fileURLToPath(new URL('..', import.meta.url))
export const reports = resolve(root, '.artifacts/production')

export function run(command, args, options = {}) {
  const { cwd = root, env = process.env, input = '', timeout = 120_000, log, allowFailure = false } = options
  return new Promise((resolveResult, reject) => {
    const started = performance.now()
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', timedOut = false, outputOverflow = false
    const capture = (channel, chunk) => {
      if (stdout.length + stderr.length + chunk.length > 8 * 1024 * 1024) {
        outputOverflow = true
        child.kill('SIGKILL')
        return
      }
      if (channel === 'stdout') stdout += chunk
      else stderr += chunk
    }
    child.stdout.on('data', chunk => capture('stdout', chunk))
    child.stderr.on('data', chunk => capture('stderr', chunk))
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error) })
    child.once('error', reject)
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeout)
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      const result = { code, signal, stdout, stderr, durationMs: Math.round(performance.now() - started), timedOut, outputOverflow }
      if (log) {
        mkdirSync(dirname(log), { recursive: true })
        appendFileSync(log, `${stdout}${stderr}\nexit=${code} signal=${signal} durationMs=${result.durationMs}\n`)
      }
      if (timedOut || outputOverflow || (!allowFailure && code !== 0)) reject(new Error(`${command} ${args.join(' ')} failed: ${JSON.stringify(result)}`))
      else resolveResult(result)
    })
    child.stdin.end(input)
  })
}

export function runNode(args, options) {
  return run(process.execPath, args, options)
}

export function runPnpm(args, options) {
  const executable = process.env.npm_execpath
  if (!executable || !/pnpm\.(?:c?js|mjs)$/.test(executable)) throw new Error('Run this script with pnpm run so the pinned package manager is available')
  return runNode([executable, ...args], options)
}

export function isolatedEnv(home, extra = {}) {
  const retained = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']
  return { ...Object.fromEntries(retained.filter(key => process.env[key]).map(key => [key, process.env[key]])), HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: resolve(home, '.config'), NO_COLOR: '1', ...extra }
}
