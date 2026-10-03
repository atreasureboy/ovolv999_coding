import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
export function loadEnvironment(entryUrl: string): void {
  const __scriptDir = dirname(fileURLToPath(entryUrl))
  const __projectRoot = resolve(__scriptDir, '..', '..')
  for (const dir of [process.cwd(), __projectRoot]) {
    const envPath = join(dir, '.env')
    if (!existsSync(envPath)) continue
    try {
      for (const line of readFileSync(envPath, 'utf8').split('\n')) {
        const t = line.trim()
        if (!t || t.startsWith('#')) continue
        const eq = t.indexOf('=')
        if (eq <= 0) continue
        const key = t.slice(0, eq).trim()
        let val = t.slice(eq + 1).trim()
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1)
        }
        if (!process.env[key]) process.env[key] = val
      }
    } catch (error) {
      void error
    }
    break
  }
}
