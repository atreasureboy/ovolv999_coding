/**
 * Security utilities for file path handling.
 *
 * Inspired by claude-code's path.ts, adapted for ovolv999. These helpers
 * are the canonical entry points for any code that handles a user-supplied
 * path — the goal is to keep three small but easy-to-miss checks in one
 * place so they can be unit-tested in isolation and called by every
 * tool that touches the filesystem.
 *
 * The functions are intentionally PURE (no I/O, no state) so they can be
 * imported freely without dragging a dependency tree along.
 */

import { homedir } from 'os'
import { join } from 'path'

/**
 * Detect path-traversal attempts. A "traversal" here means a `..` segment
 * (parent-directory reference) appearing as a path component — either at
 * the start of the path or bounded by a separator on either side. The
 * detector is intentionally strict: a `..` ANYWHERE in a path component
 * is treated as suspicious, even if the eventual resolved path stays
 * inside the intended base directory. Callers that legitimately need to
 * accept `..` segments (e.g. a tool that takes a project-relative path)
 * should resolve the path against the base BEFORE calling this function
 * — or use the returned boolean as a soft warning rather than a hard
 * block.
 *
 * The pattern `(?:^|[\\/])\.\.(?:[\\/]|$)` matches:
 *   - `..` at the very start of the string (`../foo`)
 *   - `..` after a separator (`foo/../bar`, `foo\..\bar`)
 *   - `..` at the end (`foo/..`)
 *   - A bare `..` (the whole path)
 * It does NOT match `..` embedded inside a longer name (`foo..bar`,
 * `my..backup`), which is the common false-positive case.
 */
export function containsPathTraversal(path: string): boolean {
  return /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(path)
}

/**
 * Detect NUL bytes in a path. NUL (`\0`) is a classic injection vector
 * in C-style file APIs: many syscalls treat the NUL as a string
 * terminator, so `foo\0.txt` could be passed to a syscall as `foo`,
 * with everything after the NUL silently ignored. The defense here is
 * to reject any path containing a NUL outright rather than try to clean
 * it (cleaning a hostile input rarely ends well).
 */
export function containsNullByte(path: string): boolean {
  return path.includes('\0')
}

/**
 * Expand `~` / `~/...` to the user's home directory.
 *
 * Contract:
 *   - `~/foo`        → `<homedir>/foo`
 *   - `~`            → `<homedir>`
 *   - anything else  → returned unchanged
 *
 * Security checks performed up front:
 *   1. NUL-byte detection: throws. Without this guard, an attacker
 *      could pass `foo\0~/.ssh/id_rsa` to a downstream tool that
 *      concatenates paths unsafely — the NUL would silently truncate
 *      `foo` away in any C-backed syscall.
 *   2. Other input is left alone. We intentionally do NOT validate the
 *      rest of the path here (no traversal check, no canonicalization)
 *      — those belong in the calling tool, which knows the intended
 *      base directory and the right escape policy.
 *
 * The error message includes the first 100 chars of the input so the
 * caller sees what tripped the check without leaking the full path
 * (some inputs can be arbitrarily long).
 */
export function expandPath(path: string): string {
  if (containsNullByte(path)) {
    throw new Error(`Path contains null byte: ${path.slice(0, 100)}`)
  }
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2))
  }
  if (path === '~') {
    return homedir()
  }
  return path
}