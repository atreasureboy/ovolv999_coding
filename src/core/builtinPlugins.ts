/**
 * Built-in Plugin Registration
 *
 * Registers plugins that ship with ovolv999. These provide metadata
 * about features that are always available but can be "logically disabled"
 * by the user for clarity in the /plugins UI.
 */

import { registerBuiltinPlugin } from './plugins.js'

/**
 * Register all built-in plugins. Called once at startup.
 */
export function initBuiltinPlugins(): void {
  registerBuiltinPlugin({
    name: 'core-tools',
    version: '1.0.0',
    description: 'Core tool suite: Bash, Read, Write, Edit, Grep, Glob, Agent',
    author: 'ovolv999',
    enabled: true,
  })

  registerBuiltinPlugin({
    name: 'worktree',
    version: '1.0.0',
    description: 'Git worktree isolation for parallel agent work',
    author: 'ovolv999',
    enabled: true,
  })

  registerBuiltinPlugin({
    name: 'background-tasks',
    version: '1.0.0',
    description: 'Background task management (TmuxSession, ShellSession, TaskCreate/Get/List)',
    author: 'ovolv999',
    enabled: true,
  })

  registerBuiltinPlugin({
    name: 'plan-mode',
    version: '1.0.0',
    description: 'Plan mode: analyze before executing, with approval workflow',
    author: 'ovolv999',
    enabled: true,
  })

  registerBuiltinPlugin({
    name: 'multimodal',
    version: '1.0.0',
    description: 'Multi-modal support: images in prompts, vision-capable models',
    author: 'ovolv999',
    enabled: true,
  })

  registerBuiltinPlugin({
    name: 'web-tools',
    version: '1.0.0',
    description: 'Web integration: WebFetch, WebSearch',
    author: 'ovolv999',
    enabled: true,
  })

  registerBuiltinPlugin({
    name: 'notebook',
    version: '1.0.0',
    description: 'Jupyter notebook editing support',
    author: 'ovolv999',
    enabled: true,
  })

  registerBuiltinPlugin({
    name: 'claude-code',
    version: '1.0.0',
    description: 'Claude Code (CCB) integration as a secondary agent',
    author: 'ovolv999',
    enabled: true,
  })
}
