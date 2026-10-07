import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = dirname(fileURLToPath(import.meta.url))
export function buildExecutionHost(outputDirectory = join(directory, 'bin')) {
  if (process.platform !== 'win32') throw new Error('Windows execution host requires a Windows build environment')
  const framework = join(process.env.WINDIR ?? 'C:/Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319')
  const compiler = join(framework, 'csc.exe')
  if (!existsSync(compiler)) throw new Error('Windows .NET Framework C# compiler is unavailable')
  mkdirSync(outputDirectory, { recursive: true })
  const executable = join(resolve(outputDirectory), 'execution-host.exe')
  const source = join(directory, 'src', 'ExecutionHost.cs')
  const sourceSha256 = createHash('sha256').update(readFileSync(source)).digest('hex')
  const manifestPath = join(outputDirectory, 'manifest.json')
  if (existsSync(executable) && existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (manifest.protocolVersion === 1 && manifest.platform === 'win32' && manifest.architecture === 'x64' && manifest.sourceSha256 === sourceSha256 && manifest.sha256 === createHash('sha256').update(readFileSync(executable)).digest('hex')) return { executable, sha256: manifest.sha256, protocolVersion: 1 }
  }
  const result = spawnSync(compiler, ['/nologo', '/optimize+', '/target:exe', '/platform:x64', '/out:' + executable, '/reference:' + join(framework, 'System.Web.Extensions.dll'), source], { encoding: 'utf8', windowsHide: true })
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stdout + result.stderr)
  const sha256 = createHash('sha256').update(readFileSync(executable)).digest('hex')
  writeFileSync(manifestPath, JSON.stringify({ protocolVersion: 1, platform: 'win32', architecture: 'x64', sha256, sourceSha256 }, null, 2) + '\n')
  return { executable, sha256, protocolVersion: 1 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(buildExecutionHost(process.argv[2])) + '\n')
}
