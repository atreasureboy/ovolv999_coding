import { createServer } from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createProfile } from '../../src/core/profiles.js'

it('applies strict profile to the next source CLI request and restart, and refreshes the mode prompt', async () => {
  const base = mkdtempSync(join(tmpdir(), 'ovogo-profile-runtime-'))
  const cwd = join(base, 'workspace')
  mkdirSync(cwd)
  execFileSync('git', ['init', '--quiet', cwd], { windowsHide: true })
  writeFileSync(join(cwd, '.ovolv999.json'), JSON.stringify({ model: 'fixture', enabledModules: [], maxIterations: 3 }))
  const requests: Array<Record<string, unknown>> = []
  let count = 0
  let phase = 'first'
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += String(chunk) })
    request.on('end', () => {
      requests.push(JSON.parse(body))
      const first = ++count === 1
      const delta = first
        ? { tool_calls: [{ index: 0, id: `write-${phase}`, type: 'function', function: { name: 'Write', arguments: JSON.stringify({ file_path: `${phase}.txt`, content: 'marker' }) } }] }
        : { content: 'ready' }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: first ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const outcomes = []
    for (const name of ['first', 'restart']) {
      phase = name
      count = 0
      const start = requests.length
      const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/profileModeChild.ts', import.meta.url)), cwd, phase], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HOME: base, USERPROFILE: base, OVOGO_STATE_DIR: join(base, 'state'), OPENAI_API_KEY: 'fixture', OPENAI_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, OVOGO_MODEL: 'fixture', OVOGO_MODEL_PROTOCOL: 'chat-completions', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: '', OVOGO_TEMPERATURE: '', OVOGO_MAX_OUTPUT_TOKENS: '', OVOGO_MAX_CONTEXT_TOKENS: '', OVOGO_POOR: '' },
      })
      let output = ''
      child.stdout.on('data', chunk => { output += String(chunk) })
      child.stderr.on('data', chunk => { output += String(chunk) })
      const timer = setTimeout(() => child.kill(), 20000)
      const code = await new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject) })
      clearTimeout(timer)
      outcomes.push({ code, output, marker: existsSync(join(cwd, `${phase}.txt`)), request: requests[start] })
    }
    for (const result of outcomes) expect(result.code, result.output).toBe(0)
    expect(outcomes.map(result => ({ code: result.code, marker: result.marker, temperature: result.request?.temperature }))).toEqual([
      { code: 0, marker: false, temperature: 0.3 },
      { code: 0, marker: false, temperature: 0.3 },
    ])
    expect(JSON.stringify(outcomes[0].request)).toContain('Dr. Sharp')
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(base, { recursive: true, force: true })
  }
}, 50000)

it('applies active profile sampling and instructions to the actual pipe request while keeping the explicit model', async () => {
  const base = mkdtempSync(join(tmpdir(), 'ovogo-profile-pipe-'))
  const cwd = join(base, 'workspace')
  mkdirSync(cwd)
  execFileSync('git', ['init', '--quiet', cwd], { windowsHide: true })
  let body: Record<string, unknown> | undefined
  const server = createServer((request, response) => {
    let input = ''
    request.on('data', chunk => { input += String(chunk) })
    request.on('end', () => {
      body = JSON.parse(input)
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ id: 'pipe', choices: [{ index: 0, message: { role: 'assistant', content: 'pipe ready' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    createProfile(cwd, 'work', { provider: { name: 'openai', model: 'profile-model', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKeyEnv: 'FIXTURE_KEY' }, modelPrefs: { temperature: 0.25, maxTokens: 1024, systemPrompt: 'Profile instruction fixture.' } })
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../../bin/ovogogogo.ts', import.meta.url)), '--pipe', '--cwd', cwd, '--model', 'explicit-model', 'Return ready'], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: base, USERPROFILE: base, OVOGO_STATE_DIR: join(base, 'state'), FIXTURE_KEY: 'fixture', OPENAI_API_KEY: '', OVOGO_MODEL_PROTOCOL: 'chat-completions', OVOGO_MODEL: 'environment-model', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: '', OVOGO_TEMPERATURE: '', OVOGO_MAX_OUTPUT_TOKENS: '' },
    })
    let output = ''
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.stderr.on('data', chunk => { output += String(chunk) })
    const timer = setTimeout(() => child.kill(), 20000)
    const code = await new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject) })
    clearTimeout(timer)
    expect(code, output).toBe(0)
    expect(body).toMatchObject({ model: 'explicit-model', temperature: 0.25, max_tokens: 1024 })
    expect(JSON.stringify(body?.messages)).toContain('Profile instruction fixture.')
    expect(output).toContain('pipe ready')
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(base, { recursive: true, force: true })
  }
}, 25000)
