import { createInterface } from 'node:readline'
import { writeFileSync } from 'node:fs'

if (process.env.OVOGO_START_MARKER) writeFileSync(process.env.OVOGO_START_MARKER, 'launched')
const input = createInterface({ input: process.stdin, terminal: false })
const send = message => process.stdout.write(JSON.stringify(message) + '\n')
input.on('line', line => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  let result
  if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'environment', version: '1' } }
  else if (request.method === 'tools/list') result = { tools: [{ name: 'environment', description: 'Returns the fixture child environment', inputSchema: { type: 'object' } }] }
  else if (request.method === 'tools/call') result = { content: [{ type: 'text', text: JSON.stringify(process.env) }] }
  else { send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unknown fixture method' } }); return }
  send({ jsonrpc: '2.0', id: request.id, result })
})
input.on('close', () => process.exit(0))
