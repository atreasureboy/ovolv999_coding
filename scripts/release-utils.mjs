import { spawn } from 'node:child_process'
import { mkdirSync, appendFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StringDecoder } from 'node:string_decoder'

export const root = fileURLToPath(new URL('..', import.meta.url))
export const reports = resolve(root, '.artifacts/production')

export function run(command, args, options = {}) {
  const { cwd = root, env = process.env, input = '', timeout = 120_000, log, allowFailure = false } = options
  return new Promise((resolveResult, reject) => {
    const started = performance.now()
    const child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', timedOut = false, outputOverflow = false
    let outputBytes = 0
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
    const kill = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch (error) {
        if (error.code !== 'ESRCH') fail(Object.assign(new Error('Release command process termination could not be confirmed', { cause: error }), { unfinishedResources: [`process ${child.pid ?? 'unknown'}`] }))
      }
    }
    const capture = (channel, chunk) => {
      outputBytes += chunk.length
      if (outputBytes > 8 * 1024 * 1024) {
        outputOverflow = true
        kill()
        return
      }
      if (channel === 'stdout') stdout += decoders.stdout.write(chunk)
      else stderr += decoders.stderr.write(chunk)
    }
    child.stdout.on('data', chunk => capture('stdout', chunk))
    child.stderr.on('data', chunk => capture('stderr', chunk))
    const timer = setTimeout(() => { timedOut = true; kill() }, timeout)
    const fail = error => { clearTimeout(timer); reject(error) }
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') { kill(); fail(error) } })
    child.once('error', fail)
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      stdout += decoders.stdout.end()
      stderr += decoders.stderr.end()
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
