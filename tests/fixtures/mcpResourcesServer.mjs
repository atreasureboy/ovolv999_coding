import { appendFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const [mode = 'normal', label = 'fixture', pidPath, requestPath] = process.argv.slice(2)
if (pidPath) writeFileSync(pidPath, String(process.pid))
const rl = createInterface({ input: process.stdin, terminal: false })

function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function fail(id, message, code = -32000) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
}

rl.on('line', line => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  if (requestPath) appendFileSync(requestPath, request.method + '\n')
  switch (request.method) {
    case 'initialize':
      return send(request.id, { protocolVersion: '2024-11-05', capabilities: { ...(mode === 'resource-only' ? {} : { tools: {} }), resources: {}, prompts: {} }, serverInfo: { name: label, version: '1' } })
    case 'tools/list':
      return mode === 'resource-only'
        ? fail(request.id, 'Tools unsupported', -32601)
        : send(request.id, { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] })
    case 'tools/call':
      return send(request.id, { content: [{ type: 'text', text: `${label}: ${request.params.arguments.text}` }] })
    case 'resources/list':
      if (mode === 'hang-discovery') return
      if (mode === 'exit-discovery') return process.exit(0)
      return mode === 'fail-resources'
        ? fail(request.id, 'Resource discovery unavailable')
        : send(request.id, { resources: [{ uri: 'fixture://resource', name: label, description: `${label} resource`, mimeType: 'text/plain' }] })
    case 'prompts/list':
      return send(request.id, { prompts: [{ name: 'explain', description: `${label} prompt`, arguments: [{ name: 'topic', required: true }] }] })
    case 'resources/read':
      if (mode === 'hang-read') return
      if (mode === 'exit-read') return process.exit(0)
      if (mode === 'fail-read') return fail(request.id, 'Resource read denied')
      return send(request.id, { contents: [{ uri: request.params.uri, mimeType: 'text/plain', text: mode === 'oversized-read' ? 'x'.repeat(8192) : `${label} resource body` }] })
    default:
      return fail(request.id, 'Unsupported method', -32601)
  }
})

rl.on('close', () => process.exit(0))
