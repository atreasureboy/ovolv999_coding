/**
 * File History — undo / checkpoint system for file edits
 *
 * Inspired by Claude Code's utils/fileHistory.ts (1115 lines).
 * Simplified to the core: back up files before modification, track
 * versions, support restore-to-original.
 *
 * How it works:
 *   1. Before Write/Edit modifies a file, trackEdit(filePath) backs up
 *      the current content to sessionDir/file-history/<hash>/v<timestamp>
 *   2. getEditedFiles() lists all modified files
 *   3. restoreOriginal(filePath) reverts a file to its pre-first-edit state
 *   4. getVersions(filePath) lists all backup versions with timestamps
 *
 * This gives the engine an "undo" capability — if the LLM makes bad edits,
 * the user can rewind to a known-good state.
 *
 * Bounded retention: a single file with thousands of edits would otherwise
 * produce thousands of full-content copies on disk — unbounded disk
 * pressure on long sessions. {@link MAX_VERSIONS_PER_FILE} caps the
 * versions kept per file; oldest copies are unlinked from disk and
 * removed from the in-memory index when the cap is exceeded.
 */

import { existsSync, readFileSync, mkdirSync, statSync, copyFileSync, chmodSync, closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'fs'
import { join, resolve } from 'path'
import { createHash, randomBytes } from 'crypto'

// ── Types ───────────────────────────────────────────────────────────────────

export interface FileVersion {
  version: number
  timestamp: number
  /** Size in bytes of the backup */
  size: number
  /** The backup file path on disk */
  backupPath: string
}

export interface EditedFileInfo {
  path: string
  versions: number
  originalSize: number | null
  currentSize: number | null
  lastModified: number | null
}

// ── Constants ───────────────────────────────────────────────────────────────

/**
 * Maximum number of backup versions retained per tracked file.
 *
 * When trackEdit() pushes a new version and the count exceeds this cap,
 * the OLDEST backup is unlinked from disk and removed from the
 * in-memory version index. Subsequent restores can no longer reach the
 * evicted version — the oldest still-recoverable version becomes the
 * new "original" (i.e. restoreOriginal() returns it).
 *
 * 50 was chosen so a typical coding session (~tens of edits per file)
 * stays well under the cap, while a runaway edit loop on a large file
 * can never blow up disk usage.
 */
export const MAX_VERSIONS_PER_FILE = 50

/** Length of the per-file hash used as the on-disk directory name. */
const HISTORY_DIR_HASH_LEN = 32

// ── FileHistory ─────────────────────────────────────────────────────────────

export class FileHistory {
  private historyDir: string
  /** filePath → array of backup paths (chronological, [0] = original) */
  private edits = new Map<string, string[]>()
  private versionCounter = 0

  constructor(sessionDir: string) {
    this.historyDir = join(sessionDir, 'file-history')
    try {
      mkdirSync(this.historyDir, { recursive: true })
    } catch {
      /* best-effort */
    }
  }

  /**
   * Back up a file BEFORE it's modified. Call from Write/Edit tools.
   * If the file doesn't exist yet (new file), this is a no-op.
   */
  trackEdit(filePath: string): void {
    const absPath = resolve(filePath)
    if (!existsSync(absPath)) return // new file — nothing to back up

    try {
      // Use copyFile (not read+write) to avoid loading the entire file into
      // the JS heap — prevents OOM on large tracked files (e.g. minified JS,
      // data files). Preserves file permissions via chmod sync.
      //
      // SHA-256 (instead of MD5) so a backup directory name has a much
      // wider collision space. The directory is keyed on the absolute
      // file path, so a collision would mix two unrelated files'
      // backups under the same directory — recovered via
      // restoreOriginal on the wrong file would return garbage.
      // 32 hex chars of SHA-256 is enough for any realistic session.
      const hash = createHash('sha256').update(absPath).digest('hex').slice(0, HISTORY_DIR_HASH_LEN)
      const dir = join(this.historyDir, hash)
      mkdirSync(dir, { recursive: true })

      const timestamp = Date.now()
      const backupPath = join(dir, `v${timestamp}_${this.versionCounter++}`)
      copyFileSync(absPath, backupPath) // atomic file-level copy, no heap pressure

      // Preserve file permissions on the backup
      try {
        const stat = statSync(absPath)
        chmodSync(backupPath, stat.mode)
      } catch { /* best-effort */ }

      const versions = this.edits.get(absPath) ?? []
      versions.push(backupPath)

      // Bound retention: when the cap is exceeded, evict the OLDEST
      // backup from disk and from the in-memory index. Eviction runs
      // in a loop (not a single step) so trackEdit remains correct even
      // if the cap ever shrinks across versions.
      while (versions.length > MAX_VERSIONS_PER_FILE) {
        const evicted = versions.shift()
        if (evicted !== undefined) {
          try {
            unlinkSync(evicted)
          } catch {
            /* best-effort — missing backups are already surfaced as
               null stats in getVersions() */
          }
        }
      }

      this.edits.set(absPath, versions)
    } catch {
      /* best-effort — never block the edit */
    }
  }

  /** List all files that have been edited (tracked). */
  getEditedFiles(): EditedFileInfo[] {
    const result: EditedFileInfo[] = []
    for (const [filePath, versions] of this.edits) {
      let originalSize: number | null = null
      let currentSize: number | null = null
      let lastModified: number | null = null

      try {
        originalSize = statSync(versions[0]).size
      } catch { /* backup deleted */ }
      try {
        const stat = statSync(filePath)
        currentSize = stat.size
        lastModified = stat.mtimeMs
      } catch { /* file deleted */ }

      result.push({
        path: filePath,
        versions: versions.length,
        originalSize,
        currentSize,
        lastModified,
      })
    }
    return result.sort((a, b) => a.path.localeCompare(b.path))
  }

  /** Get all backup versions for a file. Version 0 = oldest still-tracked. */
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
      } catch { /* backup deleted */ }
      return { version: i, timestamp, size, backupPath }
    })
  }

  /** Restore a file to its oldest still-tracked version. */
  restoreOriginal(filePath: string): boolean {
    return this.restoreVersion(filePath, 0)
  }

  /**
   * Restore a file to its Nth backup version. Returns false if not found.
   *
   * Atomic write: writes the backup to a uniquely-suffixed tmp file IN
   * THE SAME DIRECTORY as the live target, fsyncs it, then renames it
   * over the live file. This means a crash mid-restore can never leave
   * a half-written file at the live path — readers always see EITHER
   * the previous content OR the fully-restored content, never a torn
   * mix. The tmp suffix (pid + ms + 8 random bytes) prevents two
   * concurrent restores from clobbering each other.
   *
   * Mode rewind (rewind semantics): we capture the BACKUP's mode (the
   * mode the live file had at the moment of trackEdit, since trackEdit
   * already chmod'd the backup to match) and re-apply it to the tmp
   * just before the rename. This makes restoreVersion a true rewind:
   * BOTH content AND mode revert to the snapshot — restoring a 0755
   * executable script after the user accidentally chmod'd it to 0644
   * brings the executable bit back. Reading the BACKUP's mode (rather
   * than the live file's current mode) is the right invariant because
   * the backup is the authoritative "what the file was" record.
   *
   * Failure modes (all return false, never throw):
   *   - readFileSync of the backup fails → live file untouched.
   *   - write/fsync/close of the tmp fails → tmp unlinked in `finally`,
   *     live file untouched.
   *   - rename fails → tmp unlinked in `finally`, live file untouched.
   *   - On success, any leftover tmp from a previous failed attempt
   *     is replaced by the rename (the unlink in `finally` is a no-op
   *     on a missing path).
   */
  restoreVersion(filePath: string, version: number): boolean {
    const absPath = resolve(filePath)
    const versions = this.edits.get(absPath)
    if (!versions || version < 0 || version >= versions.length) return false

    const backupPath = versions[version]
    let content: Buffer
    try {
      content = readFileSync(backupPath)
    } catch {
      return false
    }

    // Capture the backup's mode. trackEdit already chmod'd the backup
    // to match the live file's mode at backup time, so this is exactly
    // the mode the live file SHOULD have after a rewind. If statSync
    // fails (defensive — should not happen since we just read the
    // same path), we fall through and let the umask default apply.
    let backupMode: number | undefined
    try {
      backupMode = statSync(backupPath).mode
    } catch {
      /* best-effort — see comment above */
    }

    // Unique tmp in the SAME directory as the target so the rename is
    // atomic on POSIX (cross-directory rename isn't). Suffix combines
    // pid + Date.now() ms + 8 random bytes hex — collision-free under
    // any realistic concurrency.
    const tmpPath = `${absPath}.restore.tmp.${process.pid}.${Date.now()}.${randomBytes(8).toString('hex')}`
    let tmpFd: number | null = null
    try {
      tmpFd = openSync(tmpPath, 'w')
      writeSync(tmpFd, content, 0, content.length, 0)
      fsyncSync(tmpFd)
      closeSync(tmpFd)
      tmpFd = null
      // chmod BEFORE the rename so the renamed file already has the
      // rewound mode the moment it appears at the live path. chmodSync
      // is sync on purpose — the gap between closeSync and chmod is
      // already serial on this process; making it async would just
      // add a microtask boundary.
      if (backupMode !== undefined) {
        chmodSync(tmpPath, backupMode)
      }
      renameSync(tmpPath, absPath)
      return true
    } catch {
      return false
    } finally {
      // Best-effort cleanup: close a half-open fd and unlink the tmp
      // on any failure path so we don't leak either onto disk.
      if (tmpFd !== null) {
        try { closeSync(tmpFd) } catch { /* swallow */ }
      }
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath)
      } catch {
        /* swallow */
      }
    }
  }

  /** Get a diff-style summary: "3 files edited, 12 versions tracked" */
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
      return `  ${f.path} — ${f.versions} version(s), ${sizeInfo}`
    })
    return `${files.length} file(s) edited, ${totalVersions} version(s) tracked:\n${lines.join('\n')}`
  }

  /** Clear all history (for new sessions / tests). */
  clear(): void {
    this.edits.clear()
  }
}
