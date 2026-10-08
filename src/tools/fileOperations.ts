import { atomicWrite } from '../core/atomicWrite.js'
import { createHash } from 'node:crypto'
import { digestFile } from '../core/fileDigest.js'
import { getFileState, type FileReadState } from '../core/fileState.js'
import type { ToolContext, ToolResult } from '../core/types.js'
import { resolveCanonicalPath, resolveWorkspacePath } from '../core/workspacePath.js'

interface FileOperation {
  filePath: string
  fileState: FileReadState
}

export function resolveFileOperation(
  rawPath: unknown,
  context: ToolContext,
): FileOperation | { error: ToolResult } {
  const fileState = getFileState(context)
  if (!rawPath || typeof rawPath !== 'string') {
    return { error: { content: 'Error: file_path is required', isError: true } }
  }
  try {
    return { filePath: resolveWorkspacePath(context, rawPath), fileState }
  } catch (error) {
    return { error: { content: `Error: ${(error as Error).message}`, isError: true } }
  }
}

export function prepareFileMutation(filePath: string, context: ToolContext): ToolResult | undefined {
  const backup = context.fileHistory?.trackEdit(filePath)
  if (backup?.status === 'failed') {
    return { content: `Backup failed; file was not changed: ${backup.error}`, isError: true }
  }
  context.signal?.throwIfAborted()
  return undefined
}

export async function persistFileMutation(operation: FileOperation, content: string, context?: ToolContext, completion: 'write-only' | 'format-pending' = 'write-only'): Promise<void> {
  const canonicalPath = context?.recordFileEvidence ? resolveCanonicalPath(operation.filePath) : operation.filePath
  if (context?.recordFileEvidence) {
    context.recordFileEvidence({ kind: 'builtin-file', path: operation.filePath, canonicalPath, beforeHash: await digestFile(canonicalPath), expectedHash: createHash('sha256').update(content).digest('hex'), completion })
  }
  await atomicWrite(canonicalPath, content)
  operation.fileState.markFileRead(operation.filePath, content)
  await observeFileMutation(operation.filePath, context, completion === 'write-only')
}

export async function observeFileMutation(path: string, context: ToolContext | undefined, final: boolean): Promise<void> {
  if (!context?.recordFileObservation) return
  const canonicalPath = resolveCanonicalPath(path)
  const hash = await digestFile(canonicalPath)
  if (hash === null) throw new Error('Mutated file disappeared before its observation could be recorded')
  context.recordFileObservation({ canonicalPath, hash, final })
}
