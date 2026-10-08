import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { realpathSync, writeFileSync } from 'node:fs'

const [runtime, root, stage] = process.argv.slice(2)
const { RunStore } = await import(pathToFileURL(join(runtime, 'runStore.js')).href)
const { atomicWrite } = await import(pathToFileURL(join(runtime, 'atomicWrite.js')).href)
const hash = value => createHash('sha256').update(value).digest('hex')
const file = join(root, 'file.txt')
writeFileSync(file, 'before')
const run = new RunStore(join(root, 'state'), { runId: `crash-${process.pid}`, workspace: root })
const operation = run.intent('Write', false, { inputDigest: hash('approved'), workspace: root, affectedPaths: [file], resourceIds: [] })
const canonicalPath = realpathSync(file)
run.recordFileEvidence(operation, { kind: 'builtin-file', path: file, canonicalPath, beforeHash: hash('before'), expectedHash: hash('after'), completion: 'write-only' })
if (stage !== 'before-write') await atomicWrite(file, 'after')
if (stage === 'after-observation') run.recordFileObservation(operation, { canonicalPath, hash: hash('after'), final: true })
if (stage === 'unknown-receipt') run.receipt(operation, 'unknown', 'unknown')
process.send({ path: run.path, operation, file })
await new Promise(resolve => process.once('message', resolve))
