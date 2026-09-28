import { createHash } from 'node:crypto'

export function lockPackedRuntime(lockfile, manifest, tarballName, tarballBytes) {
  const source = lockfile.replaceAll('\r\n', '\n')
  const rootImporter = /\n  \.:\n    dependencies:\n([\s\S]*?)(?=    devDependencies:|\npackages:)/.exec(source)?.[1]
  if (!rootImporter) throw new Error('Cannot find frozen runtime dependency importer')
  const versions = new Map()
  for (const match of rootImporter.matchAll(/^      (?:'([^']+)'|([^:\n]+)):\n        specifier: [^\n]+\n        version: ([^\n]+)/gm)) versions.set(match[1] ?? match[2], match[3])
  const dependencies = Object.keys(manifest.dependencies).map(name => {
    const version = versions.get(name)
    if (!version) throw new Error(`Missing frozen runtime version for ${name}`)
    return `      '${name}': ${version}`
  }).join('\n')
  if (!/^[a-z0-9][a-z0-9._-]*\.tgz$/i.test(tarballName)) throw new Error('Unexpected tarball filename')
  const reference = `file:../${tarballName}`
  const packageKey = `${manifest.name}@${reference}`
  const integrity = `sha512-${createHash('sha512').update(tarballBytes).digest('base64')}`
  const importer = `importers:\n\n  .:\n    dependencies:\n      ${manifest.name}:\n        specifier: ${reference}\n        version: ${reference}\n\n`
  const packageEntry = `  ${packageKey}:\n    resolution: {integrity: ${integrity}, tarball: ${reference}}\n    version: ${manifest.version}\n    hasBin: true\n\n`
  const snapshotEntry = `  ${packageKey}:\n    dependencies:\n${dependencies}\n\n`
  return { reference, content: source.replace(/importers:\n[\s\S]*?(?=packages:\n)/, importer).replace('packages:\n\n', `packages:\n\n${packageEntry}`).replace('snapshots:\n\n', `snapshots:\n\n${snapshotEntry}`) }
}
