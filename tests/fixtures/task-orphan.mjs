import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [mode, directory] = process.argv.slice(2)
if (mode === 'leaf') {
  writeFileSync(join(directory, 'leaf.pid'), String(process.pid))
  const timer = setInterval(() => {
    if (existsSync(join(directory, 'stop-leaf'))) {
      clearInterval(timer)
      process.exit(0)
    }
  }, 20)
  setTimeout(() => process.exit(0), 30_000)
} else {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'leaf', directory], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  const timer = setInterval(() => {
    if (existsSync(join(directory, 'exit-root'))) {
      clearInterval(timer)
      process.exit(0)
    }
  }, 20)
  setTimeout(() => process.exit(0), 35_000)
}
