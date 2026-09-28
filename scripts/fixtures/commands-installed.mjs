import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

await import(pathToFileURL(join(process.argv[2], 'builtin.js')).href)
const { dispatchSlashCommand } = await import(pathToFileURL(join(process.argv[2], 'index.js')).href)
for (const command of ['/budget', '/profile list', '/snippet list', '/knowledge', '/keybindings']) {
  const result = await dispatchSlashCommand(command, { cwd: process.cwd(), history: [] })
  assert.equal(result.type, 'text')
  assert.ok(result.value.length > 0)
}
process.stdout.write('Installed ESM slash commands passed\n')
