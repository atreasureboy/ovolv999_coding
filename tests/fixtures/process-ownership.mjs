import { spawn } from 'node:child_process'
import { writeFileSync, appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const [mode, record, ...args] = process.argv.slice(2)
const fixture = fileURLToPath(import.meta.url)

if (mode === 'fast-parent' || mode === 'output-parent') {
  const child = spawn(process.execPath, [fixture, 'worker', record], {
    detached: true,
    stdio: mode === 'output-parent' ? ['ignore', 'inherit', 'inherit'] : 'ignore',
  })
  child.unref()
  writeFileSync(record, JSON.stringify({ parentPid: process.pid, childPid: child.pid }))
  process.exit(0)
} else if (mode === 'worker') {
  appendFileSync(record + '.ready', String(process.pid))
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1000)
} else if (mode === 'stdin') {
  process.stdin.on('data', data => process.stdout.write(data))
  process.stdin.on('end', () => process.exit(0))
} else if (mode === 'args') {
  process.stdout.write(JSON.stringify({ args, cwd: process.cwd(), value: process.env.OWNERSHIP_VALUE }))
} else if (mode === 'bytes') {
  process.stdout.write(Buffer.from([0, 255, 10, 13, 128]))
  process.stderr.write(Buffer.from([254, 0, 7]))
} else if (mode === 'output-burst' || mode === 'output-finite' || mode === 'output-overflow') {
  process.stdout.write(Buffer.alloc(mode === 'output-overflow' ? 4 * 1024 * 1024 : 512 * 1024, 171))
  if (mode !== 'output-finite') setInterval(() => {}, 1000)
} else if (mode === 'cancel-spawner') {
  writeFileSync(record, JSON.stringify({ parentPid: process.pid, childPid: process.pid }))
  process.on('SIGTERM', () => {})
  setInterval(() => {
    const child = spawn(process.execPath, [fixture, 'worker', record], { detached: true, stdio: 'ignore' })
    child.unref()
    appendFileSync(record + '.children', String(child.pid) + '\n')
  }, 25)
} else {
  throw new Error('Unknown ownership fixture mode')
}
