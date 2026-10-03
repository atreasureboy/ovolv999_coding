import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request } from 'node:http'
import { RunStore } from '../src/core/runStore.js'

const roots: string[] = []
function store(): RunStore {
  const root = mkdtempSync(join(tmpdir(), 'ovo-runstore-schema-'))
  roots.push(root)
  return new RunStore(root, { runId: 'schema-run', workspace: root })
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it.each([
  { revision: -1 },
  { owner: { pid: process.pid } },
  { workspace: '' },
  { status: 'fictional_success' },
  { operations: [] },
  { operations: { malformed: { name: 'Write', readOnly: false, intentAt: new Date().toISOString(), receipt: {} } } },
  { schemaVersion: 2 },
  { parentRunId: '../outside' },
  { acceptance: { definitionHash: '', artifactVersion: 'artifact' } },
  { acceptance: { definitionHash: 'definition', artifactVersion: 42 } },
  { operations: { malformed: { name: 'Write', readOnly: 'false', intentAt: new Date().toISOString() } } },
  { operations: { malformed: { name: 'Write', readOnly: false, intentAt: '2026-10-03' } } },
  { operations: { malformed: { name: 'Write', readOnly: false, intentAt: new Date().toISOString(), receipt: { status: 'completed', recordedAt: '2026-10-03' } } } },
])('rejects invalid authoritative run data %j without rewriting it', patch => {
  const run = store()
  const invalid = JSON.stringify({ ...JSON.parse(readFileSync(run.path, 'utf8')), ...patch })
  writeFileSync(run.path, invalid)
  expect(() => RunStore.inspect(run.path)).toThrow(/corrupt|invalid|unsupported/i)
  expect(readFileSync(run.path, 'utf8')).toBe(invalid)
})

it('rejects a late receipt when only the durable owner changed', () => {
  const run = store()
  const operation = run.intent('Write', false)
  const record = JSON.parse(readFileSync(run.path, 'utf8'))
  record.owner.birthId = 'different-owner-birth'
  writeFileSync(run.path, JSON.stringify(record))
  expect(() => run.receipt(operation, 'completed')).toThrow(/owner/i)
})

it('rejects oversized records before treating them as recoverable run state', () => {
  const run = store()
  const record = JSON.parse(readFileSync(run.path, 'utf8'))
  writeFileSync(run.path, JSON.stringify({ ...record, oversized: 'x'.repeat(4 * 1024 * 1024) }))
  expect(() => RunStore.inspect(run.path)).toThrow(/limit|large|size/i)
})

it('preserves an explicitly unknown receipt as a recovery obligation', () => {
  const run = store()
  const operation = run.intent('Bash', false)
  run.receipt(operation, 'unknown')
  run.finish('completed')
  expect(RunStore.inspect(run.path).status).toBe('needs_recovery')
})

it('refuses invalid new intents and receipts before changing the record', () => {
  const run = store()
  const original = readFileSync(run.path, 'utf8')
  expect(() => run.intent('', false)).toThrow(/invalid/i)
  expect(readFileSync(run.path, 'utf8')).toBe(original)
  const operation = run.intent('Bash', false)
  expect(() => run.receipt(operation, 'invented_success')).toThrow(/invalid/i)
})

it('keeps an external accepted action unknown when its HTTP connection drops before a receipt', async () => {
  const run = store()
  let accepted = 0
  const server = createServer((req, res) => {
    req.resume()
    req.once('end', () => { accepted++; res.destroy() })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('HTTP test service unavailable')
    const operation = run.intent('external-post', false)
    await expect(new Promise<void>((resolve, reject) => {
      const outgoing = request(`http://127.0.0.1:${address.port}/accept`, { method: 'POST' }, response => { response.resume(); response.once('end', resolve) })
      outgoing.once('error', reject)
      outgoing.end('non-idempotent action')
    })).rejects.toThrow()
    run.finish('unknown')
    const recovered = RunStore.inspect(run.path)
    expect(recovered.status).toBe('needs_recovery')
    expect(recovered.operations[operation].receipt).toBeUndefined()
    expect(RunStore.inspect(run.path).status).toBe('needs_recovery')
    expect(accepted).toBe(1)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
