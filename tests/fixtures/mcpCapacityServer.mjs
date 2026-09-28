import { createInterface } from 'node:readline'
const mode = process.argv[2]
const reader = createInterface({ input: process.stdin })
reader.on('line', line => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    if (mode === 'unsupported-version') { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2099-01-01', capabilities: {} } }) + '\n'); return }
    if (mode === 'oversized') { process.stdout.write('x'.repeat(64 * 1024)); return }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'capacity', version: '1' } } }) + '\n')
  } else if (message.method === 'notifications/initialized' && mode === 'slow') {
    reader.close()
    process.stdin.pause()
    setInterval(() => {}, 1000)
  }
})
if (mode !== 'slow') reader.on('close', () => process.exit(0))
