import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { root, run, runNode } from './release-utils.mjs'
import { buildExecutionHost } from '../native/execution-host/build.mjs'

const dist = resolve(root, 'dist')
if (relative(root, dist) !== 'dist') throw new Error('Invalid build output path')
rmSync(dist, { recursive: true, force: true })
function sourceHash() {
  const files = ['package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'tsconfig.build.json']
  const collect = directory => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const file = join(directory, entry.name)
      if (file.replaceAll('\\', '/') === 'native/execution-host/bin') continue
      if (entry.isDirectory()) collect(file)
      else if (entry.isFile()) files.push(file)
    }
  }
  for (const directory of ['src', 'bin', 'scripts', 'native']) if (existsSync(join(root, directory))) collect(directory)
  const hash = createHash('sha256')
  for (const file of files.sort()) hash.update(file.replaceAll('\\', '/')).update('\0').update(readFileSync(join(root, file))).update('\0')
  return hash.digest('hex')
}
try {
  const sourceSha256 = sourceHash()
  await runNode([join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'])
  const executionHost = process.platform === 'win32' ? buildExecutionHost(join(dist, 'native/execution-host/bin')) : undefined
  if (sourceHash() !== sourceSha256) throw new Error('Build inputs changed while compiling; rebuild from a stable checkout')
  const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const commit = (await run('git', ['rev-parse', 'HEAD'])).stdout.trim()
  const status = (await run('git', ['status', '--porcelain', '--untracked-files=normal'])).stdout
  const identity = { schemaVersion: 1, version: metadata.version, gitCommit: commit, sourceDirty: status.length > 0, sourceSha256, builtAt: new Date().toISOString(), node: process.version, ...(executionHost ? { executionHost: { platform: 'win32', architecture: process.arch, protocolVersion: executionHost.protocolVersion, sha256: executionHost.sha256 } } : {}) }
  writeFileSync(join(dist, 'build-info.json'), JSON.stringify(identity, null, 2) + '\n')
  process.stdout.write(JSON.stringify(identity) + '\n')
} catch (error) {
  rmSync(dist, { recursive: true, force: true })
  throw error
}
