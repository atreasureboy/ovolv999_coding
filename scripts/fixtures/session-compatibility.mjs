import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const module = await import(pathToFileURL(process.argv[2]).href)
const root = process.argv[3]
const fixture = JSON.parse(readFileSync(new URL('./session-v1.json', import.meta.url), 'utf8'))
for (const [name, data] of [['v1', fixture], ['legacy-array', fixture.messages]]) {
  const directory = join(root, name)
  mkdirSync(directory)
  writeFileSync(join(directory, 'history.json'), JSON.stringify(data))
  const messages = module.loadSession(directory)
  assert.deepEqual(messages, fixture.messages)
  module.saveSession(directory, messages)
  assert.deepEqual(module.loadSession(directory), fixture.messages)
}
const future = join(root, 'future')
mkdirSync(future)
const raw = JSON.stringify({ ...fixture, version: 999, schema: 'ovogo.session.v999' })
writeFileSync(join(future, 'history.json'), raw)
assert.throws(() => module.loadSession(future), /version 999|unsupported.*version/i)
assert.throws(() => module.saveSession(future, fixture.messages), /version 999|unsupported.*version/i)
assert.equal(readFileSync(join(future, 'history.json'), 'utf8'), raw)
process.stdout.write(JSON.stringify({ v1ReadWrite: true, legacyMigration: true, futureReadWriteRejected: true }) + '\n')
