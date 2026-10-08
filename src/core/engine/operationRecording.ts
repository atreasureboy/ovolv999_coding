import { resolve } from 'node:path'
import { digestOperationInput } from '../operationRecovery.js'
import type { OperationEffects, RunStore } from '../runStore.js'
import type { Tool, ToolContext, ToolResult } from '../types.js'
import { FileWriteTool } from '../../tools/fileWrite.js'
import { FileEditTool } from '../../tools/fileEdit.js'
import { BashTool } from '../../tools/bash.js'

export function recordToolOperation(store: RunStore | undefined, tool: Tool, input: Record<string, unknown>, context: ToolContext) {
  const readOnly = tool.metadata?.readOnly === true
  const field = ['Write', 'Read', 'Edit'].includes(tool.name) ? 'file_path'
    : tool.name === 'NotebookEdit' ? 'notebook_path' : ['Glob', 'Grep'].includes(tool.name) ? 'path' : undefined
  const affectedPaths = field && typeof input[field] === 'string' ? [resolve(context.cwd, input[field])] : []
  const id = store?.intent(tool.name, readOnly, { inputDigest: digestOperationInput(tool.name, context.cwd, input), workspace: context.cwd, affectedPaths, resourceIds: [], summary: `${tool.name}: ${readOnly ? 'read-only' : 'mutation'} operation; ${affectedPaths.length} explicit file target(s)` })
  const toolContext: ToolContext = { ...context, recordFileEvidence: undefined, recordFileObservation: undefined, bindOperationResources: undefined }
  const trustedFile = (Object.getPrototypeOf(tool) === FileWriteTool.prototype && tool.execute === FileWriteTool.prototype.execute)
    || (Object.getPrototypeOf(tool) === FileEditTool.prototype && tool.execute === FileEditTool.prototype.execute)
  let fileEvidence = false, finalObservation = false
  if (store && id) {
    if (trustedFile) {
      toolContext.recordFileEvidence = evidence => { store.recordFileEvidence(id, evidence); fileEvidence = true }
      toolContext.recordFileObservation = observation => { store.recordFileObservation(id, observation); finalObservation ||= observation.final }
    }
    if (Object.getPrototypeOf(tool) === BashTool.prototype && tool.execute === BashTool.prototype.execute) {
      toolContext.bindOperationResources = ids => { store.bindResources(id, [...ids]) }
    }
  }
  return {
    id,
    context: toolContext,
    settle(result: ToolResult): void {
      if (!store || !id) return
      let effects: OperationEffects | undefined
      if (readOnly) effects = 'read_only'
      else if (trustedFile) effects = !fileEvidence ? 'not_started' : !result.isError && finalObservation ? 'observed_applied' : 'unknown'
      else if (result.isError || context.signal?.aborted) effects = 'unknown'
      store.receipt(id, result.status === 'cancelled' ? 'cancelled' : result.isError ? 'failed' : 'completed', effects)
    },
  }
}
