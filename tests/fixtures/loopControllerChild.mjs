import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function startLoopProvider(respond) {
  const { createServer } = await import('node:http')
  const requests = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) {
      body += chunk
      if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error('Fixture payload too large')
    }
    const payload = JSON.parse(body)
    requests.push(payload)
    await respond(payload, response, requests.length)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { requests, url: `http://127.0.0.1:${server.address().port}/v1`, close: async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  } }
}

export function reply(response, delta = { content: 'FIXTURE_TURN_FINISHED' }) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
}

export function writeCall(path, content, id = 'fixture-write') {
  return { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'Write', arguments: JSON.stringify({ file_path: path, content }) } }] }
}

if (process.argv[2] === '--child') {
  const [, , , compiled, barrier, marker, ...args] = process.argv
  const { LoopAttemptStore } = await import(pathToFileURL(join(compiled, 'src/core/autonomy/attemptStore.js')).href)
  const { RunStore } = await import(pathToFileURL(join(compiled, 'src/core/runStore.js')).href)
  const { FrozenLoop } = await import(pathToFileURL(join(compiled, 'src/core/autonomy/loopController.js')).href)
  const cwd = args[args.indexOf('--cwd') + 1]
  const park = phase => {
    writeFileSync(marker, phase)
    process.send?.({ type: 'barrier', phase })
    const result = Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 45_000)
    throw new Error(`Fixture barrier expired: ${phase}: ${result}`)
  }
  if (barrier === 'prepared') {
    const original = LoopAttemptStore.prototype.prepare
    LoopAttemptStore.prototype.prepare = function (...values) {
      const result = original.apply(this, values)
      park('prepared')
      return result
    }
  }
  if (barrier === 'effect') {
    const original = RunStore.prototype.receipt
    RunStore.prototype.receipt = function (...values) {
      if (existsSync(join(cwd, 'effect.txt'))) park('effect')
      return original.apply(this, values)
    }
  }
  if (barrier === 'settled') {
    const original = LoopAttemptStore.prototype.checkpoint
    LoopAttemptStore.prototype.checkpoint = function (...values) {
      park('settled')
      return original.apply(this, values)
    }
  }
  if (barrier === 'checkpoint') {
    const original = FrozenLoop.prototype.context
    let contexts = 0
    FrozenLoop.prototype.context = function (...values) {
      if (++contexts === 2) park('checkpoint')
      return original.apply(this, values)
    }
  }
  process.on('message', message => { if (message?.type === 'cancel') process.emit('SIGINT') })
  if (barrier === 'cancel') process.send?.({ type: 'listening' })
  process.argv = [process.execPath, join(compiled, 'bin/ovogogogo.js'), ...args]
  await import(pathToFileURL(process.argv[1]).href)
}
