import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const runtime = resolve(config.cliPath, '../../src')
const { ExecutionEngine } = await import(pathToFileURL(join(runtime, 'core/engine.js')).href)
const { Renderer } = await import(pathToFileURL(join(runtime, 'ui/renderer.js')).href)
const { createSessionDir, saveSession, releaseSessionOwnership } = await import(pathToFileURL(join(runtime, 'core/sessionManager.js')).href)
const renderer = new Renderer()
const engine = new ExecutionEngine({ cwd: config.cwd, model: 'offline-coding-fixture-v1', apiKey: 'offline-fixture-only', baseURL: config.baseURL, maxIterations: 48, permissionMode: 'auto', enabledModules: [] }, renderer)
const sessionDir = createSessionDir(config.cwd)
process.on('message', message => { if (message?.type === 'cancel') engine.abort() })
try {
  const turn = await engine.runTurn(config.prompt, [])
  saveSession(sessionDir, turn.newHistory)
  writeFileSync(config.resultPath, JSON.stringify({ result: turn.result, sessionDir }))
} finally {
  await engine.dispose()
  releaseSessionOwnership(sessionDir)
  renderer.destroy()
  process.disconnect?.()
}
