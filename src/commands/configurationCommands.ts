import type { Command } from './index.js'
import { text } from './results.js'
import type { SlashCommandContext } from './index.js'
import { listCommands } from './index.js'
import { getCurrentMode, setCurrentMode, cycleMode, getAllModes, type Mode } from '../core/modes.js'
import type { PermissionMode } from '../core/permissionSystem.js'
import { saveProjectSettings } from '../config/settings.js'
import { join } from 'path'
import { homedir } from 'os'

function persistPermissionState(ctx: SlashCommandContext): string {
  const path = ctx.persistPermissions?.(
    ctx.engine.getPermissionManager().getMode(),
    ctx.engine.getPermissionManager().getRules(),
  )
  return path ? '\nSaved to: ' + path : ''
}

export const configurationCommands: Command[] = [
  {
    name: 'mode',
    description: 'Switch or list agent modes (personas)',
    usage: '/mode [slug]  or  /mode cycle  or  /mode list',
    handler: (args, ctx) => {
      const modesDir = ctx.sessionDir ? join(homedir(), '.ovogo', 'modes') : undefined
      if (args === 'list' || args === '') {
        const modes = getAllModes(modesDir)
        const current = getCurrentMode(modesDir)
        const lines = modes.map(
          (m: Mode) =>
            '  ' +
            m.icon +
            ' ' +
            m.name.padEnd(14) +
            ' ' +
            m.slug.padEnd(14) +
            ' ' +
            (m.slug === current.slug ? '<- current ' : '') +
            m.description,
        )
        return text(
          'Available modes:\n' +
            lines.join('\n') +
            '\n\nUse /mode <slug> to switch, or /mode cycle to rotate.',
        )
      }
      if (args === 'cycle') {
        const next = cycleMode(modesDir)
        return text(
          `${next.icon} Mode switched to: ${next.name} (${next.slug}) — ${next.description}`,
        )
      }
      try {
        const mode = setCurrentMode(args, modesDir)
        return text(
          `${mode.icon} Mode switched to: ${mode.name} (${mode.slug}) — ${mode.description}`,
        )
      } catch {
        return text(`Unknown mode: "${args}". Use /mode list to see available modes.`)
      }
    },
  },
  {
    name: 'model',
    description: 'Show current model',
    aliases: ['m'],
    handler: (_args, ctx) => text(`Current model: ${ctx.engine.getModel()}`),
  },
  {
    name: 'permissions',
    description: 'Show permission configuration (default: full access, no restrictions)',
    aliases: ['perms'],
    usage:
      '/permissions [mode|cycle|rules|allow <Tool> <pattern>|deny <Tool> <pattern>|remove <index>|clear]',
    handler: (args, ctx) => {
      const mgr = ctx.engine.getPermissionManager()
      const parts = args.trim().split(/\s+/).filter(Boolean).filter(Boolean)
      const action = parts[0]
      if (!action) {
        return text(mgr.formatMode() + '\n\n' + mgr.formatRules())
      }
      if (action === 'rules') {
        return text(mgr.formatRules())
      }
      if (action === 'clear') {
        const count = mgr.getRules().length
        for (let i = count - 1; i >= 0; i--) mgr.removeRule(i)
        return text('Cleared ' + count + ' permission rule(s).' + persistPermissionState(ctx))
      }
      if (action === 'remove') {
        const index = Number.parseInt(parts[1] ?? '', 10)
        if (!Number.isInteger(index) || index < 0 || index >= mgr.getRules().length) {
          return text('Usage: /permissions remove <index>')
        }
        mgr.removeRule(index)
        return text(
          'Removed permission rule [' +
            index +
            '].\n' +
            mgr.formatRules() +
            persistPermissionState(ctx),
        )
      }
      if (action === 'cycle') {
        const next = mgr.cycleMode()
        return text(
          'Permission mode: ' +
            mgr.formatMode() +
            `\nSwitched to ${next}.` +
            persistPermissionState(ctx),
        )
      }
      if (action === 'mode') {
        const mode = parts[1] as PermissionMode | undefined
        if (!mode) return text(mgr.formatMode())
        if (!['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'].includes(mode)) {
          return text('Unknown permission mode: ' + mode)
        }
        mgr.setMode(mode)
        return text('Permission mode: ' + mgr.formatMode() + persistPermissionState(ctx))
      }
      if (action === 'allow' || action === 'deny') {
        const toolName = parts[1]
        const ruleContent = parts.slice(2).join(' ')
        if (!toolName || !ruleContent) {
          return text('Usage: /permissions ' + action + ' <ToolName> <pattern>')
        }
        mgr.addRule({
          toolName,
          ruleContent,
          behavior: action,
          source: 'user',
        })
        return text('Added permission rule:\n' + mgr.formatRules() + persistPermissionState(ctx))
      }
      return text(
        'Usage: /permissions [mode|cycle|rules|allow <Tool> <pattern>|deny <Tool> <pattern>|remove <index>|clear]',
      )
    },
  },
  {
    name: 'poor',
    description: 'Toggle Poor/Budget mode (skip critic + reflection LLM calls)',
    usage: '/poor [on|off]',
    handler: (args, ctx) => {
      const liveConfig = ctx.engine.getConfig()
      const action = args.trim().split(/\s+/).filter(Boolean)[0]
      const current = liveConfig.poor?.enabled === true
      if (!action) {
        return text(
          'Poor mode: ' +
            (current ? 'ON' : 'OFF') +
            '\n\nUse /poor on or /poor off to toggle. Skips critic self-correction and reflection LLM calls.',
        )
      }
      if (action !== 'on' && action !== 'off') {
        return text('Usage: /poor [on|off]')
      }
      const enabled = action === 'on'
      liveConfig.poor = { enabled }
      saveProjectSettings(ctx.cwd, { poor: { enabled } })
      return text('Poor mode: ' + (enabled ? 'ON' : 'OFF') + ' (saved to .ovogo/settings.json)')
    },
  },
  {
    name: 'help',
    description: 'Show all available commands',
    aliases: ['h', '?'],
    handler: (_args, _ctx) => {
      const cmds = listCommands()
      const lines = cmds.map((cmd) => {
        const aliases =
          cmd.aliases && cmd.aliases.length > 0
            ? ` (${cmd.aliases.map((a) => '/' + a).join(', ')})`
            : ''
        return '  /' + cmd.name.padEnd(16) + ' ' + cmd.description + aliases
      })
      return text(
        'Available commands:\n' +
          lines.join('\n') +
          '\n\n  /plan <task>       Plan mode — analyze then confirm before execute\n' +
          '  /<skill_name>      Run a loaded skill\n\n' +
          'Type / for autocomplete. ? for keyboard shortcuts. ESC to interrupt.',
      )
    },
  },
  {
    name: 'config',
    description: 'Show current configuration',
    handler: (_args, ctx) => {
      const lines = [
        'API key: ' + (process.env.OPENAI_API_KEY ? 'set' : 'NOT SET'),
        'Base URL: ' + (process.env.OPENAI_BASE_URL || 'default'),
        'Model: ' + ctx.engine.getModel(),
        'CWD: ' + ctx.cwd,
        'Session: ' + (ctx.sessionDir || 'none'),
      ]
      const temp = process.env.OVOGO_TEMPERATURE
      if (temp) lines.push('Temperature: ' + temp)
      const maxTok = process.env.OVOGO_MAX_OUTPUT_TOKENS
      if (maxTok) lines.push('Max output tokens: ' + maxTok)
      return text('Configuration:\n  ' + lines.join('\n  '))
    },
  },
  {
    name: 'cwd',
    description: 'Show current working directory',
    handler: (_args, ctx) => text('Working directory: ' + ctx.cwd),
  },
  {
    name: 'version',
    description: 'Show ovolv999 version',
    aliases: ['v'],
    handler: () => text('ovolv999 v0.1.0'),
  },
  {
    name: 'keybindings',
    aliases: ['keys', 'kb'],
    description: 'Show or reset keyboard shortcuts. Usage: /keybindings [reset]',
    handler: async (args, ctx) => {
      const trimmed = args.trim().toLowerCase()
      const {
        loadKeybindings,
        writeDefaultConfig,
        DEFAULT_BINDINGS,
        ACTION_DESCRIPTIONS,
        ALL_KEY_ACTIONS,
      } = await import('../ui/keybindings.js')
      if (trimmed === 'reset' || trimmed === 'default') {
        const path = writeDefaultConfig(ctx.cwd)
        return text(`✓ Reset keybindings to defaults.\nWritten to: ${path}`)
      }
      const result = loadKeybindings(ctx.cwd)
      const lines: string[] = ['Keyboard Shortcuts:', '']
      if (result.errors.length > 0) {
        lines.push('⚠ Config errors:')
        for (const e of result.errors) lines.push(`  ${e}`)
        lines.push('')
      }
      if (result.conflicts.length > 0) {
        lines.push('⚠ Conflicting key combos (using defaults instead):')
        for (const c of result.conflicts) {
          lines.push(`  ${c.key} → ${c.actions.join(', ')}`)
        }
        lines.push('')
      }
      const actionToCombo = new Map<string, string>()
      for (const [combo, action] of result.bindings) {
        actionToCombo.set(action, combo)
      }
      for (const action of ALL_KEY_ACTIONS) {
        const combo = actionToCombo.get(action) ?? DEFAULT_BINDINGS[action]
        const isUserOverride = result.hasUserConfig && combo !== DEFAULT_BINDINGS[action]
        const marker = isUserOverride ? ' *' : '  '
        const desc = ACTION_DESCRIPTIONS[action]
        lines.push(`${marker} ${combo.padEnd(18)} ${action.padEnd(20)} ${desc}`)
      }
      lines.push('')
      lines.push(
        result.hasUserConfig
          ? '* = user override (from .ovolv999/keybindings.json)'
          : 'Edit .ovolv999/keybindings.json to customize. Run /keybindings reset to create a template.',
      )
      return text(lines.join('\n'))
    },
  },
  {
    name: 'vim',
    description: 'Toggle vim editing mode for the prompt input',
    handler: () => {
      return {
        type: 'text',
        value: 'Vim mode is a UI-level toggle — use Ctrl+\\ or the status bar to switch modes.',
      }
    },
  },
  {
    name: 'models',
    aliases: ['providers'],
    description: 'List known LLM providers and models. Usage: /models [provider]',
    handler: async (args, ctx) => {
      const { MODELS, PROVIDERS, listProviders, detectProviderFromModel, getModelInfo } =
        await import('../core/providers.js')
      const trimmed = args.trim().toLowerCase()
      if (trimmed && PROVIDERS[trimmed as keyof typeof PROVIDERS]) {
        const provider = PROVIDERS[trimmed as keyof typeof PROVIDERS]
        const models = MODELS.filter((m: (typeof MODELS)[0]) => m.provider === trimmed)
        const lines: string[] = [
          `${provider.name} (${provider.id})`,
          provider.baseURL ? `  Base URL: ${provider.baseURL}` : '',
          provider.apiKeyEnv ? `  API Key:  $${provider.apiKeyEnv}` : '',
          `  OpenAI-compatible: ${provider.openAICompatible ? 'yes' : 'no'}`,
          '',
          `  Models (${models.length}):`,
        ]
        for (const m of models) {
          const ctx = `${(m.contextWindow / 1000).toFixed(0)}k`
          const price = `$${m.pricing.inputPer1M}/$${m.pricing.outputPer1M}/1M`
          const caps = [
            m.supportsVision ? 'vision' : '',
            m.supportsTools ? 'tools' : '',
            m.supportsReasoning ? 'reasoning' : '',
          ]
            .filter(Boolean)
            .join(',')
          lines.push(`    ${m.id.padEnd(35)} ${ctx.padEnd(8)} ${price.padEnd(16)} ${caps}`)
        }
        return text(lines.filter(Boolean).join('\n'))
      }
      const lines: string[] = ['LLM Providers:', '']
      for (const id of listProviders()) {
        const p = PROVIDERS[id]
        const modelCount = MODELS.filter((m: (typeof MODELS)[0]) => m.provider === id).length
        lines.push(
          `  ${p.name.padEnd(20)} ${modelCount} model(s)${p.baseURL ? `  ${p.baseURL}` : ''}`,
        )
      }
      const currentModel = ctx.engine.getModel()
      lines.push('', 'Current model: ' + currentModel)
      const detected = detectProviderFromModel(currentModel)
      if (detected !== 'unknown') {
        lines.push(`  Detected provider: ${PROVIDERS[detected].name}`)
      }
      const info = getModelInfo(currentModel)
      if (info) {
        lines.push(`  Context window: ${(info.contextWindow / 1000).toFixed(0)}k`)
        lines.push(
          `  Pricing: $${info.pricing.inputPer1M}/$${info.pricing.outputPer1M} per 1M tokens`,
        )
      }
      lines.push('', 'Usage: /models <provider> to see models for a specific provider')
      return text(lines.join('\n'))
    },
  },
  {
    name: 'style',
    aliases: ['output-style'],
    description:
      'Set or show output style. Usage: /style [concise|verbose|structured|socratic|code-focused|teaching|default]',
    handler: async (args, ctx) => {
      const { loadOutputStyles, setActiveStyle } = await import('../core/outputStyles.js')
      const trimmed = args.trim().toLowerCase()
      if (trimmed) {
        const result = setActiveStyle(ctx.cwd, trimmed)
        if (!result.success) {
          return text(`⚠ ${result.error}`)
        }
        const active = loadOutputStyles(ctx.cwd).active
        return text(`✓ Output style: ${active.name}\n${active.description}`)
      }
      const result = loadOutputStyles(ctx.cwd)
      const lines: string[] = ['Output Styles:', '']
      if (result.errors.length > 0) {
        lines.push('⚠ Config errors:')
        for (const e of result.errors) lines.push(`  ${e}`)
        lines.push('')
      }
      for (const s of result.styles) {
        const marker = s.id === result.active.id ? '▶' : ' '
        lines.push(`${marker} ${s.id.padEnd(15)} ${s.name.padEnd(15)} ${s.description}`)
      }
      lines.push('', `Active: ${result.active.name} (${result.active.id})`)
      lines.push('Usage: /style <id> to switch')
      return text(lines.join('\n'))
    },
  },
  {
    name: 'effort',
    aliases: ['thinking'],
    description: 'Set effort guidance. Usage: /effort [minimal|low|medium|high|maximum]',
    handler: async (args, ctx) => {
      const { nextEffort, isEffortLevel, getEffortPrompt, formatEffort, formatEffortList } =
        await import('../core/effort.js')
      const parts = args.trim().split(/\s+/).filter(Boolean)
      const level = parts[0]
      if (level === 'list' || level === 'ls') {
        return text(formatEffortList(ctx.engine.getEffort()))
      }
      if (level === 'cycle' || level === 'next') {
        ctx.engine.setEffort(nextEffort(ctx.engine.getEffort()))
        return text(`Effort: ${formatEffort(ctx.engine.getEffort())}\n\nGuidance: ${getEffortPrompt(ctx.engine.getEffort())}`)
      }
      if (isEffortLevel(level)) {
        ctx.engine.setEffort(level)
        return text(`Effort set to: ${formatEffort(level)}\n\nGuidance: ${getEffortPrompt(level)}`)
      }
      if (!level) return text(`Effort: ${formatEffort(ctx.engine.getEffort())}`)
      return text(`Unknown level: ${level}\n${formatEffortList(ctx.engine.getEffort())}`)
    },
  },
]
