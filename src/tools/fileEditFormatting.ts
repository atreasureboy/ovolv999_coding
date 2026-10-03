import { existsSync, readFileSync } from 'fs'
import { readFile } from 'fs/promises'
import { createRequire } from 'module'
import { dirname, join, resolve } from 'path'
import type { FileReadState } from '../core/fileState.js'
import { runFileVerificationCommand } from '../core/verification.js'

const PROJECT_MARKERS = [
  '.prettierrc', '.prettierrc.js', 'eslint.config.js',
  '.eslintrc', '.eslintrc.js', 'package.json',
]

const FORMATTERS = [
  { name: 'prettier', argument: '--write', configs: ['.prettierrc', '.prettierrc.js', 'prettier.config.js'] },
  { name: 'eslint', argument: '--fix', configs: ['.eslintrc', '.eslintrc.js', 'eslint.config.js'] },
] as const

function findProjectRoot(filePath: string): string {
  let projectRoot = dirname(filePath)
  for (let depth = 0; depth < 10; depth++) {
    if (PROJECT_MARKERS.some(marker => existsSync(join(projectRoot, marker)))) break
    const parent = dirname(projectRoot)
    if (parent === projectRoot) break
    projectRoot = parent
  }
  return projectRoot
}

export async function formatEditedFile(
  filePath: string,
  fileState: FileReadState,
  signal?: AbortSignal,
): Promise<string> {
  const projectRoot = findProjectRoot(filePath)
  let formatNote = ''
  try {
    const formatter = FORMATTERS.find(candidate => candidate.configs.some(config => existsSync(join(projectRoot, config))))
    if (formatter) {
      const require = createRequire(join(projectRoot, 'package.json'))
      const manifestPath = require.resolve(formatter.name + '/package.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin: string | Record<string, string> }
      const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin[formatter.name]
      if (bin) {
        const formatted = await runFileVerificationCommand(
          process.execPath,
          [resolve(dirname(manifestPath), bin), formatter.argument, filePath],
          projectRoot,
          signal,
          10_000,
        )
        if (formatted.passed) formatNote = ` (formatted with ${formatter.name})`
      }
    }
  } catch (error) { void error }
  signal?.throwIfAborted()

  if (formatNote) {
    try {
      fileState.markFileRead(filePath, await readFile(filePath, 'utf8'))
    } catch (error) { void error }
  }
  return formatNote
}

export function formatReplacementDiff(oldString: string, newString: string): string {
  const oldLines = oldString.split('\n')
  const newLines = newString.split('\n')
  const diffLines: string[] = []
  const maxLines = Math.max(oldLines.length, newLines.length)
  for (let index = 0; index < maxLines; index++) {
    const oldLine = oldLines[index]
    const newLine = newLines[index]
    if (oldLine !== undefined) diffLines.push(`- ${oldLine}`)
    if (newLine !== undefined && newLine !== oldLine) diffLines.push(`+ ${newLine}`)
  }
  return diffLines.length > 0 ? `\n${diffLines.join('\n')}` : ''
}
