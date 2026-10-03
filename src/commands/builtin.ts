import { registerCommand, type Command } from './index.js'
import { sessionCommands } from './sessionCommands.js'
import { transcriptCommands } from './transcriptCommands.js'
import { configurationCommands } from './configurationCommands.js'
import { workspaceCommands } from './workspaceCommands.js'
import { automationCommands } from './automationCommands.js'
import { knowledgeCommands } from './knowledgeCommands.js'
import { resourcesCommands } from './resourcesCommands.js'
import { diagnosticsCommands } from './diagnosticsCommands.js'
import { integrationsCommands } from './integrationsCommands.js'

const commandOrder = [
  'exit',
  'clear',
  'reset',
  'history',
  'compact',
  'cost',
  'mode',
  'context',
  'model',
  'permissions',
  'poor',
  'rewind',
  'undo',
  'tasks',
  'workers',
  'doctor',
  'diff',
  'commit',
  'git',
  'init',
  'skills',
  'help',
  'review',
  'security-review',
  'branch',
  'resume',
  'sessions',
  'status',
  'files',
  'config',
  'cwd',
  'search',
  'version',
  'copy',
  'retry',
  'keybindings',
  'workflow',
  'vim',
  'models',
  'skill-save',
  'style',
  'export',
  'audit',
  'suggest',
  'scan',
  'share',
  'notify',
  'debug-tool-call',
  'schedule',
  'stats',
  'diff-browser',
  'knowledge',
  'onboard',
  'cmd-history',
  'bookmark',
  'budget',
  'timer',
  'snapshot',
  'snippet',
  'profile',
  'metrics',
  'hooks',
  'diagnostics',
  'goal',
  'transcript',
  'effort',
  'team-memory',
  'vault',
  'daemon',
  'plugins',
  'dream',
  'messages',
  'sandbox',
  'sync',
  'telemetry',
  'magic-docs',
  'ssh',
  'lsp',
  'update',
  'cache',
  'health',
  'ide',
]

const commandsByName = new Map<string, Command>(
  [
    ...sessionCommands,
    ...transcriptCommands,
    ...configurationCommands,
    ...workspaceCommands,
    ...automationCommands,
    ...knowledgeCommands,
    ...resourcesCommands,
    ...diagnosticsCommands,
    ...integrationsCommands,
  ].map((command) => [command.name, command]),
)

export function registerBuiltinCommands(): void {
  for (const name of commandOrder) {
    const command = commandsByName.get(name)
    if (!command) throw new Error(`Missing built-in command: ${name}`)
    registerCommand(command)
  }
}

registerBuiltinCommands()

export { setWorkerManager, resetWorkerManager } from './automationCommands.js'
export { registerCommand } from './index.js'
export type { Command, SlashCommandContext, SlashCommandResult } from './index.js'
