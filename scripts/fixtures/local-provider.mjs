import { createServer } from 'node:http'

export async function startProvider() {
  const state = { scenario: 'text', records: [] }
  const server = createServer(async (request, response) => {
    try {
      let body = ''
      for await (const chunk of request) {
        body += chunk
        if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error('Fixture request limit exceeded')
      }
      const data = JSON.parse(body)
      state.records.push({ toolCount: data.tools?.length ?? 0 })
      const toolResults = data.messages.filter(message => message.role === 'tool').length
      const delta = state.scenario === 'edit' && toolResults < 2
        ? { tool_calls: [{ index: 0, id: `smoke-edit-${toolResults}`, type: 'function', function: { name: toolResults ? 'Edit' : 'Read', arguments: JSON.stringify(toolResults ? { file_path: 'source.txt', old_string: 'before', new_string: 'after' } : { file_path: 'source.txt' }) } }] }
        : state.scenario === 'write' && !toolResults
          ? { tool_calls: [{ index: 0, id: 'smoke-write', type: 'function', function: { name: 'Write', arguments: JSON.stringify({ file_path: 'product.txt', content: 'changed' }) } }] }
          : { content: 'OFFLINE_SMOKE_OK' }
      if (data.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(`data: ${JSON.stringify({ id: 'smoke', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
      } else {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ id: 'smoke', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'OFFLINE_SMOKE_OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
      }
    } catch {
      response.writeHead(400)
      response.end()
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { state, url: `http://127.0.0.1:${server.address().port}/v1`, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}
