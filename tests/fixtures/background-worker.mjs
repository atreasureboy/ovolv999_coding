import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

process.on('SIGTERM', () => {})
const leaf = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.send({ready:true});setInterval(()=>{},1000)"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true })
leaf.once('message', () => {
  writeFileSync(join(process.cwd(), 'owned-pids.json'), JSON.stringify({ root: process.pid, leaf: leaf.pid }))
  process.send?.({ type: 'ovogo:ready' })
  process.stdout.write('ready 你好\n')
  if (process.argv[2] === 'parent-exits') setInterval(() => { if (existsSync(join(process.cwd(), 'exit-parent'))) process.exit(0) }, 25)
})
setInterval(() => {}, 1000)
