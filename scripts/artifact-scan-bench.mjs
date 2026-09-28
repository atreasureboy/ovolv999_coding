import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureArtifactVersion } from '../dist/src/core/verification.js'

const root = await mkdtemp(join(tmpdir(), 'ovo-artifact-benchmark-'))
try {
  const results = []
  for (const [name, count, bytes] of [['small', 100, 1024], ['many-files', 5000, 512], ['large-binary', 1, 32 * 1024 * 1024]]) {
    const cwd = join(root, name)
    await mkdir(cwd)
    const data = Buffer.alloc(bytes, 42)
    for (let offset = 0; offset < count; offset += 32) await Promise.all(Array.from({ length: Math.min(32, count - offset) }, (_, index) => writeFile(join(cwd, `${offset + index}.bin`), data)))
    let metrics
    const samples = [process.memoryUsage().rss]
    const timer = setInterval(() => samples.push(process.memoryUsage().rss), 10)
    const started = performance.now()
    try {
      const version = await captureArtifactVersion(cwd, [], { onMetrics: value => { metrics = value } })
      results.push({ name, ...metrics, wallMs: Math.round(performance.now() - started), rssSamples: samples.length, rssStart: samples[0], rssPeak: Math.max(...samples), sha256: version, scans: 1 })
    } finally { clearInterval(timer) }
  }
  process.stdout.write(JSON.stringify({ node: process.version, platform: process.platform, results }, null, 2) + '\n')
} finally { await rm(root, { recursive: true, force: true }) }
