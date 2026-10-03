import { filterToolsForSubAgent } from '../agentToolFilter.js'
import type { EngineConfig, Tool } from '../types.js'

const PLAN_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'ExitPlanMode'])
const CONCURRENT_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'])

export interface StreamingToolCall {
  index: number
  id: string
  name: string
  arguments: string
}

export interface ParsedToolCall {
  tc: StreamingToolCall
  input: Record<string, unknown>
}

export interface ToolBatch {
  safe: boolean
  calls: ParsedToolCall[]
}

export function isPlanModeTool(tool: Tool | undefined, name: string): boolean {
  return tool?.metadata?.readOnly === true || PLAN_TOOLS.has(name)
}

export function allowedAgentToolNames(names: string[], config: EngineConfig): Set<string> {
  const agent = config.agent
  if (!agent) return new Set(names)
  if ((config.initialAgentDepth ?? 0) > 0) {
    return new Set(filterToolsForSubAgent(names, agent.tools, agent.disallowedTools))
  }
  return new Set(
    names.filter(
      (name) =>
        (!agent.tools || agent.tools.includes(name)) && !agent.disallowedTools?.includes(name),
    ),
  )
}

export function partitionToolCalls(calls: ParsedToolCall[], tools?: Tool[]): ToolBatch[] {
  const batches: ToolBatch[] = []
  for (const call of calls) {
    const tool = tools?.find((candidate) => candidate.name === call.tc.name)
    const declaredSafe = tool?.isConcurrencySafe
      ? tool.isConcurrencySafe(call.input)
      : (tool?.metadata?.concurrencySafe ?? CONCURRENT_TOOLS.has(call.tc.name))
    const safe = declaredSafe && (!tool || tool.metadata?.readOnly === true || tool.name === 'Bash')
    const last = batches.at(-1)
    if (last?.safe && safe) last.calls.push(call)
    else batches.push({ safe, calls: [call] })
  }
  return batches
}
