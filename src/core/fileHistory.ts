import { existsSync, readFileSync, mkdirSync, statSync, copyFileSync, chmodSync, closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync, readdirSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { createHash, randomBytes } from 'crypto'

export interface FileVersion {
  version: number
  timestamp: number

  size: number

  backupPath: string
  state?: 'present' | 'absent'
  baseline?: boolean
  recoverable?: boolean
}

export interface EditedFileInfo {
  path: string
  versions: number
  originalSize: number | null
  currentSize: number | null
  lastModified: number | null
  changeKind?: 'added' | 'deleted' | 'modified'
  baselineStatus?: 'recorded' | 'unknown' | 'unavailable'
}

export interface BackupSidecar {

  originalPath: string
  state?: 'present' | 'absent'
  baseline?: boolean
}

export interface FileBackupResult {
  status: 'backed_up' | 'failed'
  error?: string
}

export const MAX_VERSIONS_PER_FILE = 50

const HISTORY_DIR_HASH_LEN = 32

const INDEX_FILENAME = 'index.json'

const SIDECAR_SUFFIX = '.meta.json'

function sidecarFor(backupPath: string): string {
  return `${backupPath}${SIDECAR_SUFFIX}`
}

export class FileHistory {
  private historyDir: string
  private indexPath: string

  private edits = new Map<string, string[]>()
  private versionCounter = 0
  private backupFailures = new Map<string, string>()

  constructor(sessionDir: string) {
    this.historyDir = join(sessionDir, 'file-history')
    this.indexPath = join(this.historyDir, INDEX_FILENAME)
    try {
      mkdirSync(this.historyDir, { recursive: true })
    } catch (error) { void error }
    if (!this.loadIndexFromDisk()) {
      this.rebuildIndexFromTree()
    }
    this.syncVersionCounter()
  }

  private saveIndexToDisk(): void {
    const entries: Record<string, string[]> = {}
    for (const [filePath, versions] of this.edits) {
      entries[filePath] = versions.slice()
    }
    const payload = Buffer.from(JSON.stringify({ version: 1, entries }), 'utf8')
    const tmpPath = `${this.indexPath}.tmp.${process.pid}.${Date.now()}.${randomBytes(8).toString('hex')}`
    let tmpFd: number | null = null
    try {
      tmpFd = openSync(tmpPath, 'w')
      writeSync(tmpFd, payload, 0, payload.length, 0)
      fsyncSync(tmpFd)
      closeSync(tmpFd)
      tmpFd = null
      renameSync(tmpPath, this.indexPath)
    } catch {
      if (tmpFd !== null) {
        try { closeSync(tmpFd) } catch (error) { void error }
      }
      try { if (existsSync(tmpPath)) unlinkSync(tmpPath) } catch (error) { void error }
      throw new Error('File history index could not be persisted')
    }
  }

  private loadIndexFromDisk(): boolean {
    if (!existsSync(this.indexPath)) return false
    let raw: string
    try {
      raw = readFileSync(this.indexPath, 'utf8')
    } catch {
      return false
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return false
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    const entries = (parsed as Record<string, unknown>).entries
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return false
    this.edits.clear()
    for (const [filePath, backups] of Object.entries(entries as Record<string, unknown>)) {
      if (typeof filePath !== 'string' || filePath.length === 0) continue
      if (!Array.isArray(backups)) continue
      const valid: string[] = []
      for (const b of backups) {
        if (typeof b === 'string' && b.length > 0) valid.push(b)
      }
      if (valid.length > 0) this.edits.set(filePath, valid)
    }
    return true
  }

  private rebuildIndexFromTree(): void {
    let bucketDirs: string[]
    try {
      bucketDirs = readdirSync(this.historyDir)
    } catch {
      return
    }
    for (const bucket of bucketDirs) {
      if (bucket === INDEX_FILENAME) continue
      if (bucket.endsWith('.tmp')) continue // never resurrect a half-written tmp
      const bucketDir = join(this.historyDir, bucket)
      let bucketStat
      try {
        bucketStat = statSync(bucketDir)
      } catch {
        continue
      }
      if (!bucketStat.isDirectory()) continue
      let backups: string[]
      try {
        backups = readdirSync(bucketDir)
      } catch {
        continue
      }
      const validBackups = backups
        .filter((n) => /^v\d+_/.test(n) && !n.endsWith(SIDECAR_SUFFIX))
        .sort()
      if (validBackups.length === 0) continue

      for (const name of validBackups) {
        const backupPath = join(bucketDir, name)
        const originalPath = this.readSidecarOriginalPath(backupPath)
        if (originalPath === null) {
          continue
        }
        const versions = this.edits.get(originalPath) ?? []
        versions.push(backupPath)
        this.edits.set(originalPath, versions)
      }
    }
  }

  private readSidecarOriginalPath(backupPath: string): string | null {
    const sidecarPath = sidecarFor(backupPath)
    if (!existsSync(sidecarPath)) return null
    let raw: string
    try {
      raw = readFileSync(sidecarPath, 'utf8')
    } catch {
      return null
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const candidate = (parsed as Record<string, unknown>).originalPath
    if (typeof candidate !== 'string' || candidate.length === 0) return null
    return candidate
  }

  private writeSidecarToDisk(backupPath: string, originalPath: string, state: 'present' | 'absent', baseline: boolean): void {
    const sidecarPath = sidecarFor(backupPath)
    const payload = Buffer.from(
      JSON.stringify({ originalPath, state, baseline }),
      'utf8',
    )
    const tmpPath = `${sidecarPath}.tmp.${process.pid}.${Date.now()}.${randomBytes(8).toString('hex')}`
    let tmpFd: number | null = null
    try {
      tmpFd = openSync(tmpPath, 'w')
      writeSync(tmpFd, payload, 0, payload.length, 0)
      fsyncSync(tmpFd)
      closeSync(tmpFd)
      tmpFd = null
      renameSync(tmpPath, sidecarPath)
    } catch {
      if (tmpFd !== null) {
        try { closeSync(tmpFd) } catch (error) { void error }
      }
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath)
      } catch (error) { void error }
      throw new Error('Backup metadata could not be persisted')
    }
  }

  private syncVersionCounter(): void {
    let max = -1
    for (const backups of this.edits.values()) {
      for (const p of backups) {
        const m = /_(\d+)$/.exec(p)
        if (m) {
          const n = Number(m[1])
          if (Number.isFinite(n) && n > max) max = n
        }
      }
    }
    if (max >= this.versionCounter) this.versionCounter = max + 1
  }

  trackEdit(filePath: string): FileBackupResult {
    const absPath = resolve(filePath)
    const previous = this.edits.get(absPath) ?? []
    let backupPath: string | undefined
    try {
      let present = true
      try { statSync(absPath) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        present = false
      }
      const hash = createHash('sha256').update(absPath).digest('hex').slice(0, HISTORY_DIR_HASH_LEN)
      const dir = join(this.historyDir, hash)
      mkdirSync(dir, { recursive: true })
      backupPath = join(dir, `v${Date.now()}_${this.versionCounter++}`)
      if (present) {
        copyFileSync(absPath, backupPath)
        chmodSync(backupPath, statSync(absPath).mode)
      } else {
        writeFileSync(backupPath, '')
      }
      this.writeSidecarToDisk(backupPath, absPath, present ? 'present' : 'absent', previous.length === 0)
      const versions = [...previous, backupPath]
      const evicted: string[] = []
      while (versions.length > MAX_VERSIONS_PER_FILE) evicted.push(...versions.splice(1, 1))
      this.edits.set(absPath, versions)
      this.saveIndexToDisk()
      this.backupFailures.delete(absPath)
      for (const path of evicted) {
        try { unlinkSync(path) } catch (error) { void error }
        try { unlinkSync(sidecarFor(path)) } catch (error) { void error }
      }
      return { status: 'backed_up' }
    } catch (error) {
      if (previous.length > 0) this.edits.set(absPath, previous)
      else this.edits.delete(absPath)
      if (backupPath) {
        try { unlinkSync(backupPath) } catch (error) { void error }
        try { unlinkSync(sidecarFor(backupPath)) } catch (error) { void error }
      }
      const message = error instanceof Error ? error.message : 'Backup failed'
      this.backupFailures.set(absPath, message)
      return { status: 'failed', error: message }
    }
  }

  private backupMetadata(backupPath: string): BackupSidecar | undefined {
    try {
      const metadata = JSON.parse(readFileSync(sidecarFor(backupPath), 'utf8')) as BackupSidecar
      return typeof metadata.originalPath === 'string' ? metadata : undefined
    } catch {
      return undefined
    }
  }

  getEditedFiles(): EditedFileInfo[] {
    const result: EditedFileInfo[] = []
    for (const [filePath, versions] of this.edits) {
      let originalSize: number | null = null
      let currentSize: number | null = null
      let lastModified: number | null = null

      try {
        originalSize = statSync(versions[0]).size
      } catch (error) { void error }
      try {
        const stat = statSync(filePath)
        currentSize = stat.size
        lastModified = stat.mtimeMs
      } catch (error) { void error }

      const baseline = this.backupMetadata(versions[0])
      const baselineStatus = this.backupFailures.has(filePath) || !existsSync(versions[0]) ? 'unavailable' : baseline?.baseline ? 'recorded' : 'unknown'
      if (baseline?.state === 'absent' || baselineStatus !== 'recorded') originalSize = null
      result.push({
        path: filePath,
        baselineStatus,
        changeKind: baseline?.state === 'absent' && currentSize !== null ? 'added' : currentSize === null ? 'deleted' : 'modified',
        versions: versions.length,
        originalSize,
        currentSize,
        lastModified,
      })
    }
    for (const path of this.backupFailures.keys()) {
      if (!this.edits.has(path)) result.push({ path, versions: 0, originalSize: null, currentSize: null, lastModified: null, baselineStatus: 'unavailable' })
    }
    return result.sort((a, b) => a.path.localeCompare(b.path))
  }

  getVersions(filePath: string): FileVersion[] {
    const absPath = resolve(filePath)
    const versions = this.edits.get(absPath) ?? []
    return versions.map((backupPath, i) => {
      let size = 0
      let timestamp = 0
      try {
        const stat = statSync(backupPath)
        size = stat.size
        timestamp = stat.mtimeMs
      } catch (error) { void error }
      const metadata = this.backupMetadata(backupPath)
      return { version: i, timestamp, size, backupPath, state: metadata?.state, baseline: metadata?.baseline, recoverable: existsSync(backupPath) }
    })
  }

  restoreOriginal(filePath: string): boolean {
    const versions = this.edits.get(resolve(filePath))
    if (!versions?.length || !this.backupMetadata(versions[0])?.baseline) return false
    return this.restoreVersion(filePath, 0)
  }

  restoreVersion(filePath: string, version: number): boolean {
    const absPath = resolve(filePath)
    const versions = this.edits.get(absPath)
    if (!versions || !Number.isInteger(version) || version < 0 || version >= versions.length) return false

    const backupPath = versions[version]
    if (this.backupMetadata(backupPath)?.state === 'absent') {
      if (!existsSync(backupPath)) return false
      try {
        unlinkSync(absPath)
        return true
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT'
      }
    }
    let content: Buffer
    try {
      content = readFileSync(backupPath)
    } catch {
      return false
    }
    let backupMode: number | undefined
    try {
      backupMode = statSync(backupPath).mode
    } catch (error) { void error }
    const tmpPath = `${absPath}.restore.tmp.${process.pid}.${Date.now()}.${randomBytes(8).toString('hex')}`
    let tmpFd: number | null = null
    try {
      tmpFd = openSync(tmpPath, 'w')
      writeSync(tmpFd, content, 0, content.length, 0)
      fsyncSync(tmpFd)
      closeSync(tmpFd)
      tmpFd = null
      if (backupMode !== undefined) {
        chmodSync(tmpPath, backupMode)
      }
      renameSync(tmpPath, absPath)
      return true
    } catch {
      return false
    } finally {
      if (tmpFd !== null) {
        try { closeSync(tmpFd) } catch (error) { void error }
      }
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath)
      } catch (error) { void error }
    }
  }

  getSummary(): string {
    const files = this.getEditedFiles()
    if (files.length === 0) return 'No file edits tracked.'
    const totalVersions = files.reduce((sum, f) => sum + f.versions, 0)
    const lines = files.map((f) => {
      const sizeInfo =
        f.originalSize !== null && f.currentSize !== null
          ? `${f.originalSize}→${f.currentSize} bytes`
          : f.currentSize !== null
            ? `${f.currentSize} bytes`
            : '(deleted)'
      return `  ${f.path} — ${f.versions} version(s), ${f.changeKind ?? 'modified'}, ${sizeInfo}, baseline ${f.baselineStatus}`
    })
    return `${files.length} file(s) edited, ${totalVersions} version(s) tracked:\n${lines.join('\n')}`
  }

  clear(): void {
    this.edits.clear()
    this.backupFailures.clear()
    try {
      if (existsSync(this.indexPath)) unlinkSync(this.indexPath)
    } catch (error) { void error }
    try {
      const entries = readdirSync(this.historyDir)
      for (const name of entries) {
        const sub = join(this.historyDir, name)
        let st
        try {
          st = statSync(sub)
        } catch {
          continue
        }
        if (!st.isDirectory()) continue
        try {
          for (const f of readdirSync(sub)) {
            try { unlinkSync(join(sub, f)) } catch (error) { void error }
          }
          unlinkSync(sub)
        } catch (error) { void error }
      }
    } catch (error) { void error }
  }
}
