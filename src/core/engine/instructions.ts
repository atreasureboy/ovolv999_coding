import { isAbsolute, relative, resolve, sep } from 'node:path'
import { formatInstructionsForPrompt, INSTRUCTION_LIMITS, resolveTargetInstructions, type ResolvedInstruction } from '../instructionResolver.js'
import { resolveCanonicalPath } from '../workspacePath.js'
import type { ToolResult } from '../types.js'

function within(scope: string, path: string): boolean {
  if (scope === '*') return true
  const part = relative(scope, path)
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}

export class PathInstructionContext {
  private targets = new Set<string>()
  private displayed: readonly ResolvedInstruction[] = []

  constructor(private cwd: string, private workspaceBound = false) {}

  async refresh(): Promise<string> {
    const { instructions } = await resolveTargetInstructions(this.cwd, [...this.targets], { allowExternalTargets: !this.workspaceBound })
    this.displayed = instructions
    return formatInstructionsForPrompt(instructions)
  }

  async beforeTool(tool: string, input: Record<string, unknown>): Promise<ToolResult | undefined> {
    const key = ['Read', 'Write', 'Edit'].includes(tool) ? 'file_path'
      : tool === 'NotebookEdit' ? 'notebook_path'
        : ['Grep', 'Glob'].includes(tool) ? 'path' : undefined
    if (!key || typeof input[key] !== 'string' || !input[key]) return undefined
    const target = resolve(this.cwd, input[key])
    const proposed = new Set(this.targets)
    if (!proposed.has(target) && proposed.size >= INSTRUCTION_LIMITS.targetPaths) proposed.delete(proposed.values().next().value!)
    proposed.delete(target)
    proposed.add(target)
    let current: Awaited<ReturnType<typeof resolveTargetInstructions>>
    let canonicalTarget: string, boundary: string
    try {
      canonicalTarget = resolveCanonicalPath(target)
      current = await resolveTargetInstructions(this.cwd, [...proposed], { allowExternalTargets: !this.workspaceBound })
      const identity = current.targetBoundaries.find(item => relative(item.path, canonicalTarget) === '')
      if (!identity) throw new Error('Target identity changed during instruction lookup; retry with its current path')
      boundary = identity.boundary
    } catch (error) {
      this.targets.delete(target)
      return { content: `${error instanceof Error ? error.message : String(error)}. The tool was not executed; correct the target or its instruction source before retrying.`, isError: true, status: 'blocked' }
    }
    this.targets = proposed
    const applicable = (items: readonly ResolvedInstruction[]) => items.filter(item => item.scope === '*' || (item.boundary === boundary && within(item.scope, canonicalTarget))).map(item => [item.path, item.digest])
    if (JSON.stringify(applicable(current.instructions)) === JSON.stringify(applicable(this.displayed))) return undefined
    return {
      content: `Directory instructions changed or became applicable for ${target}. The tool was not executed. Review the refreshed instruction context in the next request, then retry this operation.`,
      isError: true,
      status: 'blocked',
    }
  }
}
