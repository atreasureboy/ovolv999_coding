import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { root, runNode, runPnpm } from './release-utils.mjs'

try {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 13)) throw new Error(`Node ${manifest.engines.node} is required`)
  const expected = manifest.packageManager.replace(/^pnpm@/, '')
  const actual = (await runPnpm(['--version'])).stdout.trim()
  if (actual !== expected) throw new Error(`Use pnpm ${expected}; detected ${actual}`)
  process.stdout.write('Installing frozen dependencies and rebuilding current source...\n')
  await runPnpm(['install', '--frozen-lockfile'], { timeout: 180000 })
  await runPnpm(['run', 'build'], { timeout: 180000 })
  const envPath = join(root, '.env')
  if (!existsSync(envPath)) {
    let key = process.env.OPENAI_API_KEY?.trim()
    if (!key && process.stdin.isTTY) {
      const input = createInterface({ input: process.stdin, output: process.stdout })
      try { key = (await input.question('API key (Enter to configure later): ')).trim() } finally { input.close() }
    }
    if (key) {
      if (/[\r\n]/.test(key)) throw new Error('API key must be a single line')
      writeFileSync(envPath, `OPENAI_API_KEY=${key}\n`, { mode: 0o600 })
    }
  }
  process.stdout.write('Linking the local command...\n')
  await runPnpm(['link', '--global'])
  const version = await runNode([join(root, 'dist', 'bin', 'ovogogogo.js'), '--version'])
  process.stdout.write(version.stdout + '\nSetup complete. Run ovolv999 --help for usage.\n')
} catch (error) {
  process.stderr.write(`Setup failed: ${error.message}\n`)
  process.exitCode = 1
}
