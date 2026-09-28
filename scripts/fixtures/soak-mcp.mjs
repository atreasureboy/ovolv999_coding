import { createInterface } from 'node:readline'
import { readdirSync } from 'node:fs'

const input = createInterface({ input: process.stdin })
input.on('line', line => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  let result
  if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'soak-fixture', version: '1' } }
  else if (request.method === 'tools/list') result = { tools: [{ name: 'measure', inputSchema: { type: 'object' } }] }
  else if (request.method === 'tools/call') {
    const metrics = { pid: process.pid, rss: process.memoryUsage().rss, resources: process.getActiveResourcesInfo().length, openFileDescriptors: process.platform === 'linux' ? readdirSync('/proc/self/fd').length : null, echo: request.params.arguments.payload }
    result = { content: [{ type: 'text', text: JSON.stringify(metrics) }] }
  } else result = {}
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
})
