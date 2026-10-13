import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const [cli, cwd] = process.argv.slice(2)
assert.ok(cli && cwd, 'Expected installed CLI path and coding workspace')
const child = spawn(process.execPath, [cli, 'acp', '--cwd', cwd], { windowsHide: true, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
let stderr = '', buffer = '', failure, closed = false
const messages = [], waiting = new Set()
const notify = () => { for (const waiter of [...waiting]) waiter() }
const exit = new Promise(resolve => child.once('close', code => { closed = true; notify(); resolve(code) }))
const fail = error => { failure ??= error; notify() }
child.on('error', fail)
child.stdin.on('error', fail)
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stderr.on('data', text => { stderr = (stderr + text).slice(-65536) })
child.stdout.on('data', text => {
  buffer += text
  for (;;) {
    const newline = buffer.indexOf('\n')
    if (newline < 0) break
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    try { messages.push(JSON.parse(line)) } catch { fail(new Error('ACP stdout was not JSON-RPC')) }
  }
  notify()
})
const timer = setTimeout(() => fail(new Error('ACP installed fixture timed out')), 20000)
const request = (id, method, params) => {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n')
  return new Promise((resolve, reject) => {
    const check = () => {
      const value = messages.find(message => message.id === id)
      if (value || failure || closed) {
        waiting.delete(check)
        if (value) resolve(value)
        else reject(failure ?? new Error('ACP exited before its response: ' + stderr))
      }
    }
    waiting.add(check)
    check()
  })
}
try {
  const initialized = await request(1, 'initialize', { protocolVersion: '2025-07-20' })
  assert.deepEqual(initialized.result.capabilities, { streaming: true, tools: true, multiModal: false, worktrees: false, interrupts: true })
  const forbidden = await request(2, 'file/write', { path: 'forbidden.txt', content: 'unsafe' })
  assert.equal(forbidden.error.code, -32601)
  const completed = await request(3, 'message', { text: 'edit source' })
  assert.equal(completed.result.status, 'completed', JSON.stringify(completed))
  const events = messages.filter(message => message.method === 'agent/event').map(message => message.params.event)
  assert.deepEqual(events.map(event => event.sequence), events.map((_, index) => index + 1))
  assert.equal(events.at(-1).type, 'turn.finished')
  assert.equal(events.at(-1).status, 'completed')
  assert.equal(events.at(-1).turnId, completed.result.turnId)
  assert.equal(new Set(events.map(event => event.threadId)).size, 1)
  const tools = events.filter(event => event.type === 'item.started' && event.kind === 'tool')
  assert.deepEqual(tools.map(event => event.name), ['Read', 'Edit'])
  for (const item of tools) assert.equal(events.filter(event => event.type === 'item.completed' && event.itemId === item.itemId).length, 1)
  assert.equal(readFileSync(join(cwd, 'source.txt'), 'utf8'), 'after')
  assert.equal(readFileSync(join(cwd, 'dist/verified'), 'utf8'), 'yes')
  assert.equal(existsSync(join(cwd, 'forbidden.txt')), false)
  await request(4, 'shutdown')
  assert.equal(await exit, 0, stderr)
  process.stdout.write(JSON.stringify({ eventCount: events.length, threadId: completed.result.threadId, turnId: completed.result.turnId, status: completed.result.status, toolCallIds: tools.map(event => event.toolCallId) }) + '\n')
} finally {
  clearTimeout(timer)
  if (!closed) { child.kill('SIGTERM'); await exit }
}
