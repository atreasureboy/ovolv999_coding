#!/usr/bin/env node
// Minimal MCP stdio echo server for tests.
// Implements: initialize, notifications/initialized, tools/list, tools/call.
// Newline-delimited JSON-RPC 2.0 over stdin/stdout.

import { createInterface } from 'node:readline'

const rl = createInterface({ input: process.stdin, terminal: false })

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

const tools = [
  {
    name: 'echo',
    description: 'Echoes the provided message back with an "echo: " prefix.',
    inputSchema: {
      type: 'object',
      properties: { msg: { type: 'string', description: 'text to echo' } },
      required: ['msg'],
    },
  },
]

function handleRequest(req) {
  const { id, method, params } = req
  switch (method) {
    case 'initialize':
      return send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'echo-server', version: '0.0.1' },
        },
      })
    case 'tools/list':
      return send({ jsonrpc: '2.0', id, result: { tools } })
    case 'tools/call': {
      const name = params && params.name
      const args = (params && params.arguments) || {}
      if (name === 'echo') {
        const text = typeof args.msg === 'string' ? args.msg : ''
        return send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: 'echo: ' + text }] },
        })
      }
      if (name === 'boom') {
        return send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: 'boom failed' }], isError: true },
        })
      }
      return send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Unknown tool: ${name}` },
      })
    }
    default:
      return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
  }
}

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    process.stderr.write('[echo-server] non-JSON line ignored\n')
    return
  }
  // Notifications have no id
  if (msg.id === undefined || msg.id === null) return
  handleRequest(msg)
})

rl.on('close', () => process.exit(0))
