import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractDocs } from '../../src/core/magicDocs.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('dependency documentation', () => {
  it.each(['toString', '__proto__'])('documents the external package %s through both import formats', dependency => {
    const root = mkdtempSync(join(tmpdir(), 'magic-docs-dependencies-'))
    roots.push(root)
    writeFileSync(join(root, 'esm.ts'), `import dependency from '${dependency}'\nimport duplicate from '${dependency}'\n`)
    writeFileSync(join(root, 'commonjs.js'), `const dependency = require('${dependency}')\n`)

    const result = extractDocs({ rootDir: root, sections: ['dependencies'] })

    expect(result.warnings).toEqual([])
    expect(result.sections).toEqual([{
      type: 'dependencies',
      title: 'Dependencies',
      content: `External dependencies (1):\n\n- \`${dependency}\` (used in 2 files)`,
      sourceFiles: [],
    }])
  })

  it('retains frequency ordering, numeric package ordering, and per-file deduplication', () => {
    const root = mkdtempSync(join(tmpdir(), 'magic-docs-dependency-order-'))
    roots.push(root)
    writeFileSync(join(root, 'a.ts'), "import first from 'zod'\nimport ten from '10'\nimport two from '2'\nimport duplicate from 'zod'\nimport local from './local'\n")
    writeFileSync(join(root, 'b.js'), "const second = require('zod')\nconst local = require('/absolute')\n")

    const result = extractDocs({ rootDir: root, sections: ['dependencies'] })

    expect(result.warnings).toEqual([])
    expect(result.sections[0]?.content).toBe('External dependencies (3):\n\n- `zod` (used in 2 files)\n- `2` (used in 1 file)\n- `10` (used in 1 file)')
  })
})
