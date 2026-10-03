import type { Command } from './index.js'
import { text } from './results.js'

export const integrationsCommands: Command[] = [
  {
    name: 'hooks',
    description:
      'Manage lifecycle hooks. Usage: /hooks [list | add <event> <matcher> <command> | remove <event> <index> | clear <event> | test <event> <tool>]',
    handler: async (args, ctx) => {
      const hooksModule = await import('../core/hooks.js')
      const { loadHooksConfig, saveHooksConfig, formatHooksConfig, runHook } = hooksModule
      const parts = args.trim().split(/\s+/)
      const sub = parts[0] ?? 'list'
      const config = loadHooksConfig() as Record<
        string,
        Array<{
          matcher: string
          command: string
          timeout?: number
        }>
      >
      if (sub === 'list' || sub === 'show') {
        return text(formatHooksConfig(loadHooksConfig()))
      }
      if (sub === 'add') {
        const event = parts[1]
        const matcher = parts[2] ?? '*'
        const command = parts.slice(3).join(' ')
        if (!command) return text('Usage: /hooks add <event> <matcher> <command>')
        if (!config[event]) config[event] = []
        config[event].push({ matcher, command })
        saveHooksConfig(config)
        return text(`Added hook: [${event}] ${matcher} → ${command}`)
      }
      if (sub === 'remove') {
        const event = parts[1]
        const idx = parseInt(parts[2] ?? '', 10)
        if (!config[event] || isNaN(idx)) return text('Usage: /hooks remove <event> <index>')
        if (idx < 0 || idx >= config[event].length)
          return text(`Index out of range (0-${config[event].length - 1})`)
        const removed = config[event].splice(idx, 1)[0]
        saveHooksConfig(config)
        return text(`Removed hook: [${event}] ${removed.matcher} → ${removed.command}`)
      }
      if (sub === 'clear') {
        const event = parts[1]
        if (!event) return text('Usage: /hooks clear <event>')
        config[event] = []
        saveHooksConfig(config)
        return text(`Cleared hooks for ${event}`)
      }
      if (sub === 'test') {
        const event = parts[1] ?? 'PreToolUse'
        const toolName = parts[2] ?? 'Bash'
        const hooks = config[event] ?? []
        if (hooks.length === 0) return text(`No hooks configured for ${event}`)
        const results = hooks.map((h) =>
          runHook(h, { event: event as 'PreToolUse', toolName, cwd: ctx.cwd }),
        )
        const out = results
          .map((r, i) => `[${i}] ${hooks[i].matcher} → ${r.success ? '✓' : '✗'} (${r.duration}ms)`)
          .join('\n')
        return text(out)
      }
      return text(formatHooksConfig(config))
    },
  },
  {
    name: 'plugins',
    aliases: ['plugin'],
    description:
      'Manage plugins. Usage: /plugins [list | enable <name> | disable <name> | info <name> | install <source> | uninstall <name> | rescan]',
    handler: async (args) => {
      const pluginMod = await import('../core/pluginManager.js')
      const {
        loadPlugins,
        enablePlugin,
        disablePlugin,
        getPlugin,
        listPlugins,
        installPlugin,
        uninstallPlugin,
        formatPluginList,
        formatPlugin,
      } = pluginMod
      const parts = args.trim().split(/\s+/)
      const sub = parts[0] ?? 'list'
      if (sub === 'list' || sub === 'ls') {
        return text(formatPluginList(listPlugins()))
      }
      if (sub === 'enable') {
        const name = parts[1]
        if (!name) return text('Usage: /plugins enable <name>')
        const p = enablePlugin(name)
        return text(p ? `Enabled: ${name}` : `Not found: ${name}`)
      }
      if (sub === 'disable') {
        const name = parts[1]
        if (!name) return text('Usage: /plugins disable <name>')
        const p = disablePlugin(name)
        return text(p ? `Disabled: ${name}` : `Not found: ${name}`)
      }
      if (sub === 'info') {
        const name = parts[1]
        if (!name) return text('Usage: /plugins info <name>')
        const p = getPlugin(name)
        return text(p ? formatPlugin(p) : `Not found: ${name}`)
      }
      if (sub === 'install') {
        const source = parts[1]
        if (!source) return text('Usage: /plugins install <local-path>')
        const result = installPlugin({ from: 'local', source })
        return text(result.message)
      }
      if (sub === 'uninstall') {
        const name = parts[1]
        if (!name) return text('Usage: /plugins uninstall <name>')
        const result = uninstallPlugin(name)
        return text(result.message)
      }
      if (sub === 'rescan') {
        const plugins = loadPlugins()
        return text(`Found ${plugins.length} plugin(s)`)
      }
      return text(formatPluginList(listPlugins()))
    },
  },
  {
    name: 'magic-docs',
    aliases: ['mdocs'],
    description: 'Extract project documentation. Usage: /magic-docs [write | <section>]',
    handler: async (args) => {
      const md = await import('../core/magicDocs.js')
      const parts = args.trim().split(/\s+/)
      const sub = parts[0] ?? 'preview'
      const rootDir = process.cwd()
      if (sub === 'write') {
        const outputPath = parts[1] ?? `${rootDir}/.ovolv999/magic-docs.md`
        const result = md.extractDocs({ rootDir, outputPath })
        return text(md.formatResult(result) + `\n\nWritten to ${outputPath}`)
      }
      if (sub === 'preview' || !sub) {
        const result = md.extractDocs({ rootDir })
        return text(md.formatResult(result))
      }
      const result = md.extractDocs({ rootDir, sections: [sub as never] })
      if (result.sections.length === 0) {
        return text(
          `Unknown section: ${sub}. Available: overview, api, models, config, decisions, patterns, dependencies`,
        )
      }
      return text(md.formatSection(result.sections[0]))
    },
  },
  {
    name: 'ssh',
    description:
      'SSH remote profiles. Usage: /ssh [list | add <name> <host> [user] [port] | remove <name> | test <name> | run <name> <command>]',
    handler: async (args) => {
      const ssh = await import('../core/sshRemote.js')
      const parts = args.trim().split(/\s+/)
      const sub = parts[0] ?? 'list'
      if (sub === 'list') {
        return text(ssh.formatProfileList(ssh.loadProfiles()))
      }
      if (sub === 'add') {
        const name = parts[1]
        const host = parts[2]
        if (!name || !host) return text('Usage: /ssh add <name> <host> [user] [port]')
        const profile = {
          name,
          host,
          user: parts[3] || undefined,
          port: parts[4] ? parseInt(parts[4], 10) : undefined,
        }
        ssh.addProfile(profile)
        return text(`Added SSH profile: ${name}\n` + ssh.formatProfile(profile))
      }
      if (sub === 'remove') {
        const name = parts[1]
        if (!name) return text('Usage: /ssh remove <name>')
        const ok = ssh.removeProfile(name)
        return text(ok ? `Removed ${name}` : `Not found: ${name}`)
      }
      if (sub === 'test') {
        const name = parts[1]
        if (!name) return text('Usage: /ssh test <name>')
        const profile = ssh.getProfile(name)
        if (!profile) return text(`Profile not found: ${name}`)
        const result = ssh.testConnection(profile)
        return text(ssh.formatConnectionTest(result))
      }
      if (sub === 'run') {
        const name = parts[1]
        const cmd = parts.slice(2).join(' ')
        if (!name || !cmd) return text('Usage: /ssh run <name> <command>')
        const profile = ssh.getProfile(name)
        if (!profile) return text(`Profile not found: ${name}`)
        const result = ssh.execRemote(profile, cmd)
        return text(ssh.formatExecResult(result))
      }
      return text(ssh.formatProfileList(ssh.loadProfiles()))
    },
  },
  {
    name: 'lsp',
    description: 'Language server status. Usage: /lsp [status | symbols <query>]',
    handler: async (args) => {
      const lsp = await import('../core/lspClient.js')
      const parts = args.trim().split(/\s+/)
      const sub = parts[0] ?? 'status'
      if (sub === 'status') {
        const spec = lsp.detectServer('typescript')
        const lines = ['LSP Status:']
        lines.push(`  Detected server: ${spec ? spec.command : 'none'}`)
        lines.push(
          `  Default client running: ${lsp.getDefaultLspClient(lsp.pathToFileUri(process.cwd())).isRunning() ? 'yes' : 'no'}`,
        )
        return text(lines.join('\n'))
      }
      if (sub === 'symbols') {
        const query = parts.slice(1).join(' ')
        if (!query) return text('Usage: /lsp symbols <query>')
        const client = lsp.getDefaultLspClient(lsp.pathToFileUri(process.cwd()))
        if (!client.isRunning()) {
          const started = await client.start()
          if (!started) return text('LSP server not available')
        }
        const symbols = await client.workspaceSymbols(query)
        if (symbols.length === 0) return text('No symbols found.')
        const lines = [`Found ${symbols.length} symbol(s):`]
        for (const s of symbols.slice(0, 30)) {
          lines.push(`  ${s.name} (kind ${s.kind}) — ${s.location.uri}`)
        }
        return text(lines.join('\n'))
      }
      return text('Usage: /lsp [status | symbols <query>]')
    },
  },
  {
    name: 'update',
    description:
      'Check for ovolv999 updates. Usage: /update [check | ignore <version> | install [beta]]',
    handler: async (args) => {
      const upd = await import('../utils/autoUpdater.js')
      const parts = args.trim().split(/\s+/)
      const sub = parts[0] ?? 'check'
      if (sub === 'check') {
        const cached = upd.getCachedCheck()
        if (cached) return text(upd.formatUpdateCheckResult(cached) + '\n(cached)')
        const result = upd.checkForUpdates()
        upd.setCachedCheck(result)
        return text(upd.formatUpdateCheckResult(result))
      }
      if (sub === 'ignore') {
        const version = parts[1]
        if (!version) return text('Usage: /update ignore <version>')
        upd.ignoreVersion(version)
        return text(`Ignoring version ${version}`)
      }
      if (sub === 'install') {
        const channel = (parts[1] as 'latest' | 'beta') ?? 'latest'
        const result = upd.performUpdate(channel)
        return text(result.message)
      }
      return text('Usage: /update [check | ignore <version> | install [beta]]')
    },
  },
  {
    name: 'ide',
    description: 'IDE detection info. Usage: /ide',
    handler: async () => {
      const ide = await import('../utils/ide.js')
      const info = ide.detectIDE()
      if (!info) return text('No IDE detected (running in a plain terminal).')
      const lines = [ide.formatIDEInfo(info), '']
      const recs = ide.getExtensionRecommendations(info.type)
      if (recs.length > 0) {
        lines.push('Recommended extensions:')
        for (const r of recs) {
          lines.push(`  ${r.id}: ${r.name} — ${r.reason}`)
        }
      }
      return text(lines.join('\n'))
    },
  },
]
