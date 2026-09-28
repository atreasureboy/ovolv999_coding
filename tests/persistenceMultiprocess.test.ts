import { afterEach, expect, it } from 'vitest'
import { fork, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SemanticMemory } from '../src/core/semanticMemory.js'
import { EpisodicMemory } from '../src/core/episodicMemory.js'
import { transpileModule, ModuleKind } from 'typescript'

const dirs: string[] = []
const children: ChildProcess[] = []
const fixture = fileURLToPath(new URL('./fixtures/semanticWriter.mjs', import.meta.url))

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Child ${child.pid} did not stop during test cleanup`)), 2_000)
      child.once('close', () => { clearTimeout(timer); resolve() })
      child.kill()
    })
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function worker(dir: string, mode: string) {
  const runtime = join(dir, 'runtime')
  if (!existsSync(runtime)) {
    mkdirSync(runtime, { recursive: true })
    writeFileSync(join(runtime, 'package.json'), '{"type":"module"}')
    for (const name of ['semanticMemory', 'episodicMemory', 'persistenceLock']) {
      const source = readFileSync(new URL(`../src/core/${name}.ts`, import.meta.url), 'utf8')
      writeFileSync(join(runtime, `${name}.js`), transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: 9 } }).outputText)
    }
  }
  const module = mode.startsWith('episode') ? 'episodicMemory.js' : 'semanticMemory.js'
  const child = fork(fixture, [dir, mode, pathToFileURL(join(runtime, module)).href], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  children.push(child)
  const messages: unknown[] = []
  let stderr = ''
  let closed = false
  child.stderr?.on('data', data => { stderr += String(data) })
  child.on('error', error => { stderr += error.stack ?? error.message })
  child.on('message', value => messages.push(value))
  child.on('close', () => { closed = true })
  return { child, messages, get closed() { return closed }, diagnostics: () => `${mode}: exit=${child.exitCode} signal=${child.signalCode}\n${stderr}\n${JSON.stringify(messages)}` }
}

async function until(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Child process did not reach expected state')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

it('serializes an actual process append against a delayed full rewrite without losing either entry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ovo-multiprocess-'))
  dirs.push(dir)
  const memory = new SemanticMemory(dir)
  memory.write({ content: 'shared baseline', tags: [], source: 'user_stated', confidence: 0.1, timestamp: '' })
  const rewriting = worker(dir, 'rewrite')
  const appending = worker(dir, 'append')
  await until(() => rewriting.messages.includes('ready') && appending.messages.includes('ready'))
  rewriting.child.send('start')
  await until(() => rewriting.messages.includes('rewriting'))
  appending.child.send('start')
  await until(() => appending.messages.includes('contended') || appending.closed)
  expect(appending.messages, appending.diagnostics()).toContain('contended')
  writeFileSync(join(dir, 'release-rewrite'), '')
  await until(() => rewriting.closed && appending.closed)
  expect(rewriting.child.exitCode, rewriting.diagnostics()).toBe(0)
  expect(appending.child.exitCode, appending.diagnostics()).toBe(0)
  expect(rewriting.messages).toContainEqual({ persistence: 'persisted' })
  expect(appending.messages).toContainEqual({ persistence: 'persisted' })
  expect(new SemanticMemory(dir).readAll().map(value => value.content).sort()).toEqual(['other process append', 'shared baseline'])
}, 10_000)

it('recovers a lock left by a process that actually exited', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ovo-dead-writer-'))
  dirs.push(dir)
  const memory = new SemanticMemory(dir)
  const holder = worker(dir, 'lock')
  await until(() => holder.messages.includes('ready'))
  holder.child.send('start')
  await until(() => holder.closed)
  expect(holder.child.exitCode, holder.diagnostics()).toBe(0)
  expect(existsSync(join(dir, 'memory', 'semantic.jsonl.lock'))).toBe(true)
  const result = memory.write({ content: 'recovered write', tags: [], source: 'user_stated', confidence: 0.8, timestamp: '' })
  expect(result.persistence).toBe('persisted')
  expect(new SemanticMemory(dir).readAll()[0].content).toBe('recovered write')
}, 10_000)

it('serializes actual episodic retention rewrites against another process append', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ovo-episodic-processes-'))
  dirs.push(dir)
  const memory = new EpisodicMemory(dir, { maxEpisodes: 2 })
  for (let turn = 0; turn < 2; turn++) memory.write({ turn, toolName: 'Read', inputSummary: 'baseline', resultSummary: '', outcome: 'success', timestamp: '' })
  const rewriting = worker(dir, 'episode-rewrite')
  const appending = worker(dir, 'episode-append')
  await until(() => rewriting.messages.includes('ready') && appending.messages.includes('ready'))
  rewriting.child.send('start')
  await until(() => rewriting.messages.includes('rewriting'))
  appending.child.send('start')
  await until(() => appending.messages.includes('contended') || appending.closed)
  expect(appending.messages, appending.diagnostics()).toContain('contended')
  writeFileSync(join(dir, 'release-rewrite'), '')
  await until(() => rewriting.closed && appending.closed)
  expect(rewriting.child.exitCode, rewriting.diagnostics()).toBe(0)
  expect(appending.child.exitCode, appending.diagnostics()).toBe(0)
  expect(rewriting.messages).toContainEqual({ persistence: 'persisted' })
  expect(appending.messages).toContainEqual({ persistence: 'persisted' })
  expect(new EpisodicMemory(dir).readAll().map(value => value.inputSummary)).toEqual(['episode-rewrite', 'episode-append'])
}, 10_000)
