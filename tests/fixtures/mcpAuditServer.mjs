import { createInterface } from 'node:readline'

const mode = process.argv[2]
const input = createInterface({ input: process.stdin })
input.on('line', line => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  const base = { jsonrpc: '2.0', id: request.id }
  if (request.method === 'initialize') {
    process.stdout.write(JSON.stringify({ ...base, result: { protocolVersion: '2024-11-05', capabilities: {} } }) + '\n')
    return
  }
  if (mode === 'disconnect') {
    process.exit(1)
  }
  if (mode === 'silent') return
  const response = mode === 'unsupported'
    ? { ...base, error: { code: -32601, message: 'Method not found' } }
    : mode === 'bad-array'
      ? { ...base, result: { resources: {}, prompts: {}, tools: {} } }
      : mode === 'missing-result'
        ? base
        : { ...base, error: { code: -32000, message: 'Backend unavailable' } }
  process.stdout.write(JSON.stringify(response) + '\n')
})
