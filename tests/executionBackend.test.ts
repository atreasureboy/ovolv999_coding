import { afterEach, expect, it } from 'vitest'
import { once } from 'events'
import { spawnManaged, getExecutionHealth } from '../src/core/executionBackend.js'
import type { ChildProcess } from 'child_process'

const children: ChildProcess[] = []
afterEach(async () => { await Promise.all(children.splice(0).map(async child => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'close') } })) })

it('filters the environment of an actual child and preserves trusted defaults', async () => {
  const child = spawnManaged(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { env: { ...process.env, OVOGO_SECRET: 'hidden', OVOGO_VISIBLE: 'visible' }, profile: { mode: 'trusted-local', envAllowlist: ['OVOGO_VISIBLE'] }, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  let output = ''
  child.stdout!.on('data', data => { output += String(data) })
  await once(child, 'close')
  const env = JSON.parse(output)
  expect(env.OVOGO_SECRET).toBeUndefined()
  expect(env.OVOGO_VISIBLE).toBe('visible')
})

it('does not start an unisolated process when isolation is requested', () => {
  expect(() => spawnManaged(process.execPath, ['-e', 'process.exit(0)'], { profile: { mode: 'isolated-worker' } })).toThrow(/isolation.*unavailable/i)
})

it('holds capacity until a real process closes', async () => {
  const child = spawnManaged(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { profile: { mode: 'trusted-local', maxProcesses: 1 } })
  children.push(child)
  await once(child, 'spawn')
  expect(() => spawnManaged(process.execPath, [], { profile: { mode: 'trusted-local', maxProcesses: 1 } })).toThrow(/capacity/i)
  child.kill()
  await once(child, 'close')
  expect(getExecutionHealth().activeProcesses).toBe(0)
})
