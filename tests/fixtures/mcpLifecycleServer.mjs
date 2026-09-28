import { createInterface } from 'node:readline'
import { writeFileSync } from 'node:fs'

const [pidPath, mode] = process.argv.slice(2)
writeFileSync(pidPath, String(process.pid))
const reader = createInterface({ input: process.stdin })
reader.on('line', line => {
  const message = JSON.parse(line)
  if (message.id === undefined || mode === 'hang-initialize') return
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'lifecycle', version: '1' } } }) + '\n')
  } else if (message.method === 'tools/list') {
    const payload = mode === 'fail-list' ? { error: { code: -32603, message: 'intentional list failure' } } : { result: { tools: [{ name: 'hang', inputSchema: { type: 'object', properties: {} } }] } }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...payload }) + '\n')
  }
})
reader.on('close', () => process.exit(0))
