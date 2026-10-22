import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'

const [root, phase] = process.argv.slice(2)
const rename = fs.renameSync
fs.renameSync = (source, destination) => {
  if (phase === 'before-checkpoint-rename' && destination === join(root, 'loop-controller', 'state.json')) {
    const state = JSON.parse(fs.readFileSync(source, 'utf8'))
    if (state.current?.phase === 'checkpointed') {
      process.send({ phase })
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
    }
  }
  const result = rename(source, destination)
  if (phase === 'after-prepare-rename' && destination === join(root, 'loop-controller', 'state.json') && JSON.parse(fs.readFileSync(destination, 'utf8')).current?.phase === 'prepared') {
    process.send({ phase })
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  }
  return result
}
syncBuiltinESMExports()
const { LoopAttemptStore } = await import('../../src/core/autonomy/attemptStore.ts')
const store = await LoopAttemptStore.open({ sessionDir: root, mode: 'create', identity: { workspace: root, sessionId: 'session-1', goalHash: 'goal-1', definitionHash: 'definition-1' }, maxIterations: 2, stagnationLimit: 3 })
let state = store.prepare(0)
if (phase !== 'prepared') {
  state = store.dispatch(state.current.id, state.revision, { threadId: 'thread-1', turnId: 'turn-1' })
  state = store.settle(state.current.id, state.revision, { threadId: 'thread-1', turnId: 'turn-1', finishedSequence: 5, historyRevision: 2, status: 'completed', reason: 'stop_sequence', unfinishedResources: [] })
}
if (phase === 'before-checkpoint-rename') {
  const evidence = store.writeEvidence(state.current.id, { status: 'passed', sufficientForCompletion: true, workspace: root, definitionHash: 'definition-1', artifactVersion: 'artifact-1', commands: [{ kind: 'task_acceptance', command: 'check', passed: true, exitCode: 0, output: 'passed' }], output: 'passed', truncated: false })
  store.checkpoint(state.current.id, state.revision, { artifactVersion: 'artifact-1', evidence, verificationSource: 'loop', stagnation: { count: 0 }, decision: { action: 'stop', status: 'completed', detail: 'passed' }, acceptedAt: new Date().toISOString() }, () => {})
}
process.send({ phase })
setInterval(() => {}, 1000)
