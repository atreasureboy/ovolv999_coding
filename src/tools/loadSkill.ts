/**
 * LoadSkillTool — lets the LLM proactively load a skill's full prompt.
 *
 * At boot time, the engine injects a skill INDEX (name + description only).
 * The LLM can then call load_skill to get the full prompt when it decides
 * a skill is relevant. This is lazy loading — saves context budget.
 *
 */

import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../core/types.js'
import { str } from '../core/strings.js'
import { createSkillRuntime, type SkillRegistryEntry } from '../skills/runtime.js'

/**
 * Create a LoadSkillTool bound to a specific skill registry.
 * The skill map is injected at construction time so the tool always
 * reads from the latest loaded skills.
 */
export function createLoadSkillTool(skills: Map<string, SkillRegistryEntry>): Tool {
  const runtime = createSkillRuntime(skills)
  return {
    name: 'load_skill',
    metadata: { readOnly: true, concurrencySafe: true },
    definition: {
      type: 'function',
      function: {
        name: 'load_skill',
        description: `Load a skill's full prompt by name. At startup, only the skill index (name + description) is injected. Use this tool to get the complete prompt when you need it.

Available skills can be found in the system prompt's skill index section. Each skill may declare required tools — loading will fail if your agent doesn't have those tools.`,
        parameters: {
          type: 'object',
          properties: {
            skill_name: {
              type: 'string',
              description: 'Name of the skill to load',
            },
            args: {
              type: 'string',
              description: 'Arguments to substitute into the skill prompt',
            },
          },
          required: ['skill_name'],
        },
      },
    } satisfies ToolDefinition,

    execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const skillName = str(input.skill_name)

      if (!skillName) {
        return Promise.resolve({ content: 'Error: skill_name is required', isError: true })
      }

      if (!skills.has(skillName)) {
        const available = [...skills.keys()].filter((name) => runtime.resolveSkillInvocation(name, '', 'model').eligible).join(', ')
        return Promise.resolve({
          content: `Skill "${skillName}" not found. Available: ${available}`,
          isError: true,
        })
      }

      const invocation = runtime.resolveSkillInvocation(skillName, str(input.args), 'model')
      if (!invocation.eligible) {
        return Promise.resolve({ content: invocation.diagnostics.join('\n'), isError: true })
      }
      if (invocation.requiredTools.length > 0 && context.availableToolNames) {
        const available = new Set(context.availableToolNames)
        const missing = invocation.requiredTools.filter(t => !available.has(t))
        if (missing.length > 0) {
          return Promise.resolve({
            content: `Skill "${skillName}" requires tools not available: ${missing.join(', ')}`,
            isError: true,
          })
        }
      }

      const toolsNote = invocation.requiredTools.length
        ? `\n\n**Required tools**: ${invocation.requiredTools.join(', ')}`
        : ''
      const diagnostics = invocation.diagnostics.length ? `\n\n${invocation.diagnostics.join('\n')}` : ''

      return Promise.resolve({
        content: `Skill "${invocation.name}" loaded.\nSource: ${invocation.sourcePath}${toolsNote}${diagnostics}\n\n---\n\n${invocation.prompt}`,
        isError: false,
      })
    },
  }
}
