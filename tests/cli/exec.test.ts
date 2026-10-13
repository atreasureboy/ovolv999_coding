import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const fixtures: Array<{ base: string; server: Server }> = []
const children = new Set<ChildProcess>()
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
      child.kill('SIGTERM')
      await closed
    }
  }
  children.clear()
  for (const { base, server } of fixtures.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(base, { recursive: true, force: true })
  }
})

async function setup(output = 'ready', coding = false) {
  const base = mkdtempSync(join(tmpdir(), 'ovo-exec-jsonl-'))
  const cwd = join(base, 'workspace')
  mkdirSync(cwd)
  writeFileSync(join(cwd, '.ovolv999.json'), JSON.stringify({ model: 'fixture', enabledModules: [], permissionMode: 'auto', modelSettings: { fixture: { capabilities: { structuredOutput: true } } } }))
  const requests: Array<Record<string, unknown>> = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += String(chunk) })
    request.on('end', () => {
      const data = JSON.parse(body) as { messages: Array<{ role: string }>; tools?: unknown[] }
      requests.push(data)
      const count = data.messages.filter(message => message.role === 'tool').length
      const tool = coding && count < 2 ? { name: count ? 'Edit' : 'Read', input: count ? { file_path: 'source.txt', old_string: 'before', new_string: 'after' } : { file_path: 'source.txt' } } : undefined
      const delta = tool ? { tool_calls: [{ index: 0, id: 'call-' + count, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.input) } }] } : { content: output }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture address unavailable')
  fixtures.push({ base, server })
  const run = (args: string[], stdin = '') => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', resolve('bin/ovogogogo.ts'), 'exec', '--jsonl', '--cwd', cwd, ...args], { cwd: resolve('.'), windowsHide: true, env: { ...process.env, USERPROFILE: base, HOME: base, OVOGO_STATE_DIR: join(base, 'runtime'), OPENAI_API_KEY: 'fixture', OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`, OVOGO_MODEL: 'fixture' }, stdio: ['pipe', 'pipe', 'pipe'] })
    children.add(child)
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', (text: string) => { stdout += text })
    child.stderr.on('data', (text: string) => { stderr += text })
    child.once('error', reject)
    child.once('close', code => { children.delete(child); resolveRun({ code, stdout, stderr }) })
    child.stdin.end(stdin)
  })
  return { cwd, requests, run }
}

it('runs the actual coding CLI with only ordered JSONL on stdout', async () => {
  const { cwd, run } = await setup('ready', true)
  writeFileSync(join(cwd, 'source.txt'), 'before')
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node verify.cjs' } }))
  writeFileSync(join(cwd, 'verify.cjs'), "const fs=require('fs');if(fs.readFileSync('source.txt','utf8')!=='after')process.exit(9);fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/verified.txt','yes')")
  const result = await run(['edit source'])
  const events = result.stdout.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
  expect(result.code, result.stderr + '\n' + result.stdout).toBe(0)
  expect(events.map(event => event.sequence)).toEqual(events.map((_, index) => index + 1))
  expect(new Set(events.map(event => event.turnId)).size).toBe(1)
  expect(events.at(-1)).toMatchObject({ type: 'turn.finished', status: 'completed' })
  expect(events.filter(event => event.type === 'item.started' && event.kind === 'tool').map(event => event.toolCallId)).toEqual(['call-0', 'call-1'])
  expect(readFileSync(join(cwd, 'source.txt'), 'utf8')).toBe('after')
  expect(readFileSync(join(cwd, 'dist/verified.txt'), 'utf8')).toBe('yes')
})

it('rejects unsupported output schemas before any provider request', async () => {
  const { cwd, run, requests } = await setup()
  writeFileSync(join(cwd, 'schema.json'), '{"type":"object","patternProperties":{}}')
  const result = await run(['--output-schema', join(cwd, 'schema.json'), 'respond'])
  expect(result.code).toBe(1)
  expect(requests).toHaveLength(0)
  expect(result.stdout).toBe('')
  expect(result.stderr).toMatch(/schema|unsupported/i)
})

it('sends a validated schema and fails locally when the final JSON has the wrong type', async () => {
  const { cwd, run, requests } = await setup('{"answer":42}')
  writeFileSync(join(cwd, 'schema.json'), '{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false}')
  const result = await run(['--output-schema', join(cwd, 'schema.json'), 'respond'])
  const events = result.stdout.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
  expect(result.code, result.stderr).toBe(1)
  expect(events.at(-1)).toMatchObject({ type: 'turn.finished', status: 'failed' })
  expect(requests[0].response_format).toMatchObject({ type: 'json_schema', json_schema: { schema: { required: ['answer'] } } })
})

it.each([['plain', 'x'.repeat(140_000)], ['escaped', '\u0001'.repeat(22_000)]])('delivers an explicit terminal and artifact for oversized %s output', async (_name, output) => {
  const { cwd, run } = await setup(output)
  const result = await run(['respond'])
  const events = result.stdout.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
  expect(result.code, result.stderr).toBe(0)
  expect(events.at(-1)).toMatchObject({ type: 'turn.finished', status: 'completed', truncated: true, artifact: expect.any(String) })
  expect(events.filter(event => event.type === 'item.delta' && String(event.itemId).startsWith('assistant:')).map(event => event.text).join('')).toBe(output)
  const sessionDir = readdirSync(join(cwd, 'sessions')).find(name => name.startsWith('session_'))!
  expect(JSON.parse(readFileSync(join(cwd, 'sessions', sessionDir, String(events.at(-1)!.artifact)), 'utf8'))).toMatchObject({ output, status: 'completed' })
})
