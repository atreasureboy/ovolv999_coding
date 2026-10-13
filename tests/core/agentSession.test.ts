import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { AgentEventStore } from '../../src/core/agentEventStore.js'
import { pruneTurnResults, saveTurnResult } from '../../src/core/agentSession.js'
import type { TurnResult } from '../../src/core/types.js'

const directories: string[] = []
const stores: AgentEventStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'ovo-result-retention-'))
  directories.push(path)
  return path
}

function result(runId: string): TurnResult {
  return { runId, status: 'completed', stopped: false, reason: 'stop_sequence', output: 'large'.repeat(20_000) }
}

it('prunes only managed results no longer referenced by retained events or checkpoint', async () => {
  const sessionDir = directory()
  const store = new AgentEventStore({ cwd: sessionDir, sessionDir, threadId: 'retention', maxSegments: 2 })
  stores.push(store)
  const artifacts: string[] = []
  for (let revision = 1; revision <= 4; revision++) {
    const turnId = randomUUID()
    store.append({ type: 'turn.started', turnId, runId: turnId, cwd: sessionDir, historyRevision: revision - 1 })
    const terminal = await saveTurnResult(sessionDir, turnId, result(turnId))
    artifacts.push(terminal.artifact!)
    store.append({ type: 'turn.finished', turnId, status: 'completed', historyRevision: revision, ...terminal })
    store.checkpoint({ historyRevision: revision, turnId })
  }
  const note = join(sessionDir, 'agent-results', 'notes.json')
  writeFileSync(note, 'user note')
  expect(store.retainedArtifacts()).toEqual(artifacts.slice(-2))
  pruneTurnResults(sessionDir, store.retainedArtifacts())
  expect(artifacts.map(artifact => existsSync(join(sessionDir, artifact)))).toEqual([false, false, true, true])
  expect(readFileSync(note, 'utf8')).toBe('user note')
  store.close()
  const reader = new AgentEventStore({ cwd: sessionDir, sessionDir, threadId: 'retention', readOnly: true, maxSegments: 2 })
  stores.push(reader)
  expect(reader.retainedArtifacts()).toEqual(artifacts.slice(-2))
})

it('preflights missing references and leaves every old result intact', async () => {
  const sessionDir = directory(), turnId = randomUUID()
  const terminal = await saveTurnResult(sessionDir, turnId, result(turnId))
  expect(() => pruneTurnResults(sessionDir, [`agent-results/${randomUUID()}.json`])).toThrow(/missing/i)
  expect(existsSync(join(sessionDir, terminal.artifact!))).toBe(true)
})

it('keeps the published checkpoint artifact when a later completed turn has not checkpointed', async () => {
  const sessionDir = directory()
  const options = { cwd: sessionDir, sessionDir, threadId: 'checkpoint-retention', maxSegments: 1 }
  const store = new AgentEventStore(options)
  stores.push(store)
  const artifacts: string[] = []
  for (let revision = 1; revision <= 2; revision++) {
    const turnId = randomUUID()
    store.append({ type: 'turn.started', turnId, runId: turnId, cwd: sessionDir, historyRevision: revision - 1 })
    const terminal = await saveTurnResult(sessionDir, turnId, result(turnId))
    artifacts.push(terminal.artifact!)
    store.append({ type: 'turn.finished', turnId, status: 'completed', historyRevision: revision, ...terminal })
    if (revision === 1) store.checkpoint({ historyRevision: revision, turnId })
  }
  store.close()
  const reopened = new AgentEventStore(options)
  stores.push(reopened)
  pruneTurnResults(sessionDir, reopened.retainedArtifacts())
  expect(artifacts.map(artifact => existsSync(join(sessionDir, artifact)))).toEqual([true, true])
})

it('rejects a redirected result directory without touching its target', () => {
  const sessionDir = directory(), outside = directory(), turnId = randomUUID()
  const target = join(outside, turnId + '.json')
  writeFileSync(target, JSON.stringify(result(turnId)))
  symlinkSync(outside, join(sessionDir, 'agent-results'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => pruneTurnResults(sessionDir, [])).toThrow(/unsafe/i)
  expect(existsSync(target)).toBe(true)
})

it('rejects a stale writer reference set before it can delete its successor result', async () => {
  const sessionDir = directory()
  const options = { cwd: sessionDir, sessionDir, threadId: 'revoked-retention' }
  const oldWriter = new AgentEventStore(options)
  const owners = join(sessionDir, 'agent-events', 'writer.lock.owners')
  renameSync(owners, join(sessionDir, 'retired-owners'))
  const nextWriter = new AgentEventStore(options)
  stores.push(nextWriter)
  const turnId = randomUUID()
  nextWriter.append({ type: 'turn.started', turnId, runId: turnId, cwd: sessionDir, historyRevision: 0 })
  const terminal = await saveTurnResult(sessionDir, turnId, result(turnId))
  nextWriter.append({ type: 'turn.finished', turnId, status: 'completed', historyRevision: 1, ...terminal })
  nextWriter.checkpoint({ historyRevision: 1, turnId })
  try {
    expect(() => pruneTurnResults(sessionDir, oldWriter.retainedArtifacts())).toThrow(/lease|owner|lock/i)
    expect(existsSync(join(sessionDir, terminal.artifact!))).toBe(true)
  } finally { try { oldWriter.close() } catch (error) { void error } }
})

it('preserves damaged managed evidence and rejects path traversal references', () => {
  const sessionDir = directory(), turnId = randomUUID()
  mkdirSync(join(sessionDir, 'agent-results'))
  const target = join(sessionDir, 'agent-results', turnId + '.json')
  writeFileSync(target, '{corrupt')
  expect(() => pruneTurnResults(sessionDir, ['../outside.json'])).toThrow(/reference/i)
  expect(() => pruneTurnResults(sessionDir, [])).toThrow(/result/i)
  expect(readFileSync(target, 'utf8')).toBe('{corrupt')
})
