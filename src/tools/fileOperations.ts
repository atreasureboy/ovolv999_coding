import { atomicWrite } from '../core/atomicWrite.js'
import { getFileState, type FileReadState } from '../core/fileState.js'
import type { ToolContext, ToolResult } from '../core/types.js'
import { resolveWorkspacePath } from '../core/workspacePath.js'

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

export async function persistFileMutation(operation: FileOperation, content: string): Promise<void> {
  await atomicWrite(operation.filePath, content)
  operation.fileState.markFileRead(operation.filePath, content)
}
