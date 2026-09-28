import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EventLog } from '../src/core/eventLog.js'

const roots: string[] = []
function root(): string { const dir = mkdtempSync(join(tmpdir(), 'ovo-log-policy-')); roots.push(dir); return dir }
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })

it('correlates versioned events while redacting credentials, tool inputs and output', () => {
  const dir = root()
  const log = new EventLog(dir)
  log.append('tool_call', 'Bash', { run_id: 'run-a', operation_id: 'operation-a', apiKey: 'secret-a', input: { command: 'secret command' }, stdout: 'secret stdout', reason: 'token=secret-b' })
  const raw = readFileSync(log.getFilePath(), 'utf8')
  expect(raw).not.toMatch(/secret-a|secret-b|secret command|secret stdout/)
  expect(JSON.parse(raw)).toMatchObject({ schemaVersion: 1, runId: 'run-a', operationId: 'operation-a' })
})

it('reports diagnostic persistence failures without pretending the event was persisted', () => {
  const dir = root()
  const log = new EventLog(dir)
  mkdirSync(log.getFilePath())
  log.append('module_flag', 'engine', { stage: 'start' })
  expect(log.getHealth()).toMatchObject({ writable: false, failedWrites: 1 })
})

it('caps one entry even when rotation is configured with a small budget', () => {
  const dir = root()
  const log = new EventLog(dir, { maxEntryBytes: 1024, rotateBytes: 4096 })
  log.append('module_flag', 'engine', { values: Array.from({ length: 10000 }, () => 'x'.repeat(1000)) })
  expect(Buffer.byteLength(readFileSync(log.getFilePath(), 'utf8'))).toBeLessThanOrEqual(1024)
})
