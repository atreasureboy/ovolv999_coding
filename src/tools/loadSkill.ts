/**
 * LoadSkillTool — lets the LLM proactively load a skill's full prompt.
 *
 * At boot time, the engine injects a skill INDEX (name + description only).
 * The LLM can then call load_skill to get the full prompt when it decides
 * a skill is relevant. This is lazy loading — saves context budget.
 *
 * Permission check: skill.tools must be a subset of the agent's available tools.
 */

import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../core/types.js'
import { str } from '../core/strings.js'

/** Skill map type — matches skills/loader.ts Skill interface */
interface SkillEntry {
  name: string
  description: string
  prompt: string
  tools?: string[]
}

/**
 * Create a LoadSkillTool bound to a specific skill registry.
 * The skill map is injected at construction time so the tool always
 * reads from the latest loaded skills.
 */
export function createLoadSkillTool(skills: Map<string, SkillEntry>): Tool {
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

      const skill = skills.get(skillName)
      if (!skill) {
        const available = [...skills.keys()].join(', ')
        return Promise.resolve({
          content: `Skill "${skillName}" not found. Available: ${available}`,
          isError: true,
        })
      }

      // Permission check: skill.tools must be subset of agent's available tools
      if (skill.tools && skill.tools.length > 0 && context.availableToolNames) {
        const available = new Set(context.availableToolNames)
        const missing = skill.tools.filter(t => !available.has(t))
        if (missing.length > 0) {
          return Promise.resolve({
            content: `Skill "${skillName}" requires tools not available: ${missing.join(', ')}`,
            isError: true,
          })
        }
      }

      const toolsNote = skill.tools?.length
        ? `\n\n**Required tools**: ${skill.tools.join(', ')}`
        : ''

      return Promise.resolve({
        content: `Skill "${skill.name}" loaded.${toolsNote}\n\n---\n\n${skill.prompt}`,
        isError: false,
      })
    },
  }
}
