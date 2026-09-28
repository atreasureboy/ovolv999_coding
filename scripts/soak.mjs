import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { root, reports } from './release-utils.mjs'

const profileIndex = process.argv.indexOf('--profile')
const profileName = profileIndex < 0 ? 'short' : process.argv[profileIndex + 1]
const profiles = JSON.parse(readFileSync(new URL('./soak.config.json', import.meta.url), 'utf8'))
const profile = profiles[profileName]
if (!profile) throw new Error('Choose --profile short or --profile long')
if (!existsSync(join(root, 'dist/build-info.json'))) throw new Error('Run pnpm run build before soak')
const { McpStdioClient } = await import(pathToFileURL(join(root, 'dist/src/core/mcpClient.js')).href)
const client = new McpStdioClient({ name: 'local-soak', type: 'stdio', command: [process.execPath, join(root, 'scripts/fixtures/soak-mcp.mjs')], limits: { maxPending: profile.batchSize, maxQueuedBytes: 1024 * 1024, maxFrameBytes: 1024 * 1024 } })
const samples = []
const started = performance.now()
let completedRequests = 0, childPid, failure, finalHealth
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
try {
  await client.connect()
  const tools = await client.listTools()
  assert.equal(tools[0].name, 'measure')
  const payload = 'x'.repeat(profile.payloadBytes)
  while (performance.now() - started < profile.durationMs) {
    const requests = Array.from({ length: profile.batchSize }, () => client.callTool('measure', { payload }))
    const dispatchedHealth = client.getHealth()
    const values = await Promise.all(requests)
    for (const value of values) {
      assert.equal(value.isError, false)
      const metrics = JSON.parse(value.content)
      assert.equal(metrics.echo, payload)
      childPid = metrics.pid
    }
    const child = JSON.parse(values[0].content)
    completedRequests += values.length
    const health = client.getHealth()
    assert.equal(health.pending, 0)
    assert.equal(health.queuedBytes, 0)
    assert.equal(health.bufferedBytes, 0)
    samples.push({ elapsedMs: Math.round(performance.now() - started), rss: process.memoryUsage().rss, resources: process.getActiveResourcesInfo().length, openFileDescriptors: process.platform === 'linux' ? readdirSync('/proc/self/fd').length : null, childRss: child.rss, childResources: child.resources, childOpenFileDescriptors: child.openFileDescriptors, liveFixtureProcesses: alive(childPid) ? 1 : 0, pendingAtDispatch: dispatchedHealth.pending, queuedBytesAtDispatch: dispatchedHealth.queuedBytes, pending: health.pending, queuedBytes: health.queuedBytes })
    await setTimeout(profile.sampleIntervalMs)
  }
  assert.ok(samples.length >= 5)
  const first = samples[Math.min(2, samples.length - 1)], last = samples.at(-1)
  assert.ok(Math.max(...samples.map(sample => sample.rss)) <= profile.maxRssBytes, 'Host RSS exceeded configured cap')
  assert.ok(Math.max(...samples.map(sample => sample.childRss)) <= profile.maxRssBytes, 'Fixture RSS exceeded configured cap')
  assert.ok(last.rss - first.rss <= profile.maxRssGrowthBytes, 'Host RSS grew beyond configured cap')
  assert.ok(last.childRss - first.childRss <= profile.maxRssGrowthBytes, 'Fixture RSS grew beyond configured cap')
  assert.ok(last.resources - first.resources <= profile.maxResourcesGrowth, 'Host active resources grew beyond configured cap')
  assert.ok(last.childResources - first.childResources <= profile.maxResourcesGrowth, 'Fixture active resources grew beyond configured cap')
} catch (error) {
  failure = error.message
} finally {
  try {
    await client.close()
    if (childPid) {
      const deadline = performance.now() + 5000
      while (alive(childPid) && performance.now() < deadline) await setTimeout(50)
      assert.equal(alive(childPid), false, 'Fixture process survived close')
    }
    finalHealth = client.getHealth()
    assert.equal(finalHealth.pending, 0)
    assert.equal(finalHealth.queuedBytes, 0)
  } catch (error) { failure ??= error.message }
  mkdirSync(reports, { recursive: true })
  const first = samples[Math.min(2, samples.length - 1)], last = samples.at(-1)
  const trend = first && last ? { rssGrowthBytes: last.rss - first.rss, childRssGrowthBytes: last.childRss - first.childRss, resourceGrowth: last.resources - first.resources, childResourceGrowth: last.childResources - first.childResources, rssBytesPerSecond: (last.rss - first.rss) / Math.max(1, (last.elapsedMs - first.elapsedMs) / 1000) } : null
  const result = { passed: !failure, profile: profileName, limits: profile, platform: process.platform, node: process.version, build: JSON.parse(readFileSync(join(root, 'dist/build-info.json'), 'utf8')), durationMs: Math.round(performance.now() - started), completedRequests, trend, finalHealth, windowsKernelHandlesMeasured: false, samples, failure }
  writeFileSync(join(reports, `release-soak-${profileName}.json`), JSON.stringify(result, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ ...result, samples: `${samples.length} samples in report` }) + '\n')
  if (failure) process.exitCode = 1
}
