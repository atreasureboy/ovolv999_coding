import type { Command } from './index.js'
import { text } from './results.js'
import type { BudgetType, BudgetPeriod } from '../core/budget.js'

export const resourcesCommands: Command[] = [
  {
    name: 'budget',
    description:
      'Manage token/cost budgets. Usage: /budget [set|list|remove|reset|check|preset <name>|record]',
    handler: async (args, ctx) => {
      const {
        setBudget,
        removeBudget,
        listBudgets,
        recordUsage,
        checkBudget,
        checkAllBudgets,
        resetUsage,
        getBudgetSnapshot,
        formatBudgetUsage,
        formatBudgetSummary,
        formatBudgetSnapshot,
        applyPreset,
        BUDGET_PRESETS,
      } = await import('../core/budget.js')
      const parts = args.trim().split(/\s+/).filter(Boolean)
      const sub = parts[0] ?? 'list'
      if (sub === 'set') {
        const [name, type, period, limitStr] = parts.slice(1)
        if (!name || !type || !period || !limitStr) {
          return text(
            'Usage: /budget set <name> <tokens|cost|requests> <session|daily|weekly|monthly> <limit>',
          )
        }
        const limit = parseFloat(limitStr)
        if (isNaN(limit)) return text('Invalid limit number')
        const validTypes = ['tokens', 'cost', 'requests']
        const validPeriods = ['session', 'daily', 'weekly', 'monthly']
        if (!validTypes.includes(type)) return text(`Type must be one of: ${validTypes.join(', ')}`)
        if (!validPeriods.includes(period))
          return text(`Period must be one of: ${validPeriods.join(', ')}`)
        const bm = setBudget(ctx.cwd, {
          name,
          type: type as BudgetType,
          period: period as BudgetPeriod,
          limit,
        })
        return text(`✓ Budget set: ${bm.name} (${bm.type}/${bm.period}) limit=${bm.limit}`)
      }
      if (sub === 'remove' || sub === 'rm') {
        const name = parts[1]
        if (!name) return text('Usage: /budget remove <name>')
        return text(removeBudget(ctx.cwd, name) ? `✓ Removed budget "${name}"` : 'Budget not found')
      }
      if (sub === 'reset') {
        const name = parts[1]
        if (!name) return text('Usage: /budget reset <name>')
        return text(resetUsage(ctx.cwd, name) ? `✓ Reset usage for "${name}"` : 'Budget not found')
      }
      if (sub === 'check') {
        const name = parts[1]
        if (name) {
          const check = checkBudget(ctx.cwd, name)
          return text(check.reason)
        }
        const { allAllowed, results } = checkAllBudgets(ctx.cwd)
        const lines = results.map((r) => `  ${r.config.name}: ${r.result.reason}`)
        lines.push('')
        lines.push(allAllowed ? 'All budgets OK' : '⚠ Some budgets exceeded!')
        return text(lines.join('\n'))
      }
      if (sub === 'record') {
        const name = parts[1]
        const amount = parseFloat(parts[2] ?? '')
        if (!name || isNaN(amount)) return text('Usage: /budget record <name> <amount>')
        const usage = recordUsage(ctx.cwd, name, amount)
        if (!usage) return text('Budget not found or disabled')
        const config = listBudgets(ctx.cwd).find((b) => b.name === name)!
        return text(formatBudgetUsage(config, usage))
      }
      if (sub === 'preset') {
        const presetName = parts[1] as keyof typeof BUDGET_PRESETS
        if (!presetName || !(presetName in BUDGET_PRESETS)) {
          return text(`Available presets: ${Object.keys(BUDGET_PRESETS).join(', ')}`)
        }
        const budgets = applyPreset(ctx.cwd, presetName)
        return text(
          `✓ Applied "${presetName}" preset:\n` +
            budgets.map((b) => `  ${b.name}: ${b.type}/${b.period} = ${b.limit}`).join('\n'),
        )
      }
      if (sub === 'show') {
        const name = parts[1]
        if (!name) return text('Usage: /budget show <name>')
        const snap = getBudgetSnapshot(ctx.cwd, name)
        if (!snap) return text('Budget not found')
        return text(formatBudgetSnapshot(snap))
      }
      if (sub === 'list' || !sub) {
        return text(formatBudgetSummary(ctx.cwd))
      }
      return text(`Usage: /budget [set|list|remove|reset|check|preset|record|show]`)
    },
  },
  {
    name: 'profile',
    aliases: ['profiles', 'prof'],
    description:
      'Manage config profiles. Usage: /profile [create|list|switch|show|remove|clone|export|import|config]',
    handler: async (args, ctx) => {
      const {
        createProfile,
        removeProfile,
        getProfile,
        getActiveProfile,
        setActiveProfile,
        listProfiles,
        loadProfiles,
        cloneProfile,
        exportProfile,
        importProfile,
        getEffectiveConfig,
        initializeBuiltinProfiles,
        formatProfile,
        formatProfileList,
        formatEffectiveConfig,
      } = await import('../core/profiles.js')
      const parts = args.trim().split(/\s+/).filter(Boolean)
      const sub = parts[0] ?? 'list'
      if (sub === 'create' || sub === 'add') {
        const name = parts[1]
        if (!name) return text('Usage: /profile create <name>')
        const p = createProfile(ctx.cwd, name, {
          description: parts.slice(2).join(' ') || undefined,
        })
        return text(`✓ Profile created: ${p.name}`)
      }
      if (sub === 'switch' || sub === 'use') {
        const name = parts[1]
        if (!name) return text('Usage: /profile switch <name>')
        if (!setActiveProfile(ctx.cwd, name)) return text('Profile not found')
        return text(`✓ Switched to profile: ${name}`)
      }
      if (sub === 'remove' || sub === 'rm') {
        const name = parts[1]
        if (!name) return text('Usage: /profile remove <name>')
        return text(
          removeProfile(ctx.cwd, name) ? `✓ Removed profile "${name}"` : 'Profile not found',
        )
      }
      if (sub === 'show') {
        const name = parts[1]
        const profile = name ? getProfile(ctx.cwd, name) : getActiveProfile(ctx.cwd)
        if (!profile) return text('Profile not found')
        return text(formatProfile(profile))
      }
      if (sub === 'clone') {
        const src = parts[1]
        const dst = parts[2]
        if (!src || !dst) return text('Usage: /profile clone <source> <new-name>')
        const cloned = cloneProfile(ctx.cwd, src, dst)
        return cloned ? text(`✓ Cloned "${src}" → "${dst}"`) : text('Source profile not found')
      }
      if (sub === 'export') {
        const name = parts[1]
        if (!name) return text('Usage: /profile export <name>')
        const json = exportProfile(ctx.cwd, name)
        return json ? text(json) : text('Profile not found')
      }
      if (sub === 'import') {
        const json = parts.slice(1).join(' ')
        if (!json) return text('Usage: /profile import <json>')
        const p = importProfile(ctx.cwd, json)
        return p ? text(`✓ Imported profile: ${p.name}`) : text('Invalid JSON')
      }
      if (sub === 'config') {
        const config = getEffectiveConfig(ctx.cwd)
        return text(formatEffectiveConfig(config))
      }
      if (sub === 'init') {
        const profiles = initializeBuiltinProfiles(ctx.cwd)
        return text(`✓ Initialized ${profiles.length} builtin profiles`)
      }
      if (sub === 'list' || !sub) {
        const store = loadProfiles(ctx.cwd)
        return text(formatProfileList(listProfiles(ctx.cwd), store.activeProfile))
      }
      return text(
        `Usage: /profile [create|list|switch|show|remove|clone|export|import|config|init]`,
      )
    },
  },
  {
    name: 'vault',
    aliases: ['secrets', 'keychain'],
    description:
      'Manage local vault. Usage: /vault [status | set <key> | get <key> | delete <key> | list]',
    handler: async (args) => {
      const keychainModule = await import('../utils/keychain.js')
      const {
        setSecret,
        getSecret,
        deleteSecret,
        listSecrets,
        getVaultMetadata,
        formatVaultStatus,
        getPassphraseFromEnv,
      } = keychainModule
      const parts = args.trim().split(/\s+/).filter(Boolean)
      const sub = parts[0] ?? 'status'
      if (sub === 'status') {
        const pass = getPassphraseFromEnv()
        return text(formatVaultStatus(getVaultMetadata(pass)))
      }
      if (sub === 'set') {
        const key = parts[1]
        if (!key) return text('Usage: /vault set <key>')
        const pass = getPassphraseFromEnv()
        process.stdout.write(`Enter value for ${key}: `)
        try {
          const moduleName = 'readline-sync'
          const inputModule = (await import(moduleName)) as {
            question?: (
              prompt: string,
              options: {
                hideEchoBack: boolean
              },
            ) => unknown
          }
          if (typeof inputModule.question !== 'function')
            throw new Error('Secret input unavailable')
          const value = inputModule.question('', { hideEchoBack: true })
          if (typeof value !== 'string') throw new Error('Secret input must be text')
          setSecret(key, value, pass ?? undefined)
          return text(`Stored: ${key}`)
        } catch {
          return text('Failed to read value (readline-sync not available)')
        }
      }
      if (sub === 'get') {
        const key = parts[1]
        if (!key) return text('Usage: /vault get <key>')
        const pass = getPassphraseFromEnv()
        const value = getSecret(key, pass ?? undefined)
        return text(value ? value : `Not found: ${key}`)
      }
      if (sub === 'delete') {
        const key = parts[1]
        if (!key) return text('Usage: /vault delete <key>')
        const pass = getPassphraseFromEnv()
        const deleted = deleteSecret(key, pass ?? undefined)
        return text(deleted ? `Deleted: ${key}` : `Not found: ${key}`)
      }
      if (sub === 'list') {
        const pass = getPassphraseFromEnv()
        const keys = listSecrets(pass ?? undefined)
        return text(keys.length > 0 ? keys.join('\n') : 'No secrets stored')
      }
      return text('Usage: /vault [status | set <key> | get <key> | delete <key> | list]')
    },
  },
  {
    name: 'sandbox',
    description:
      'Sandbox configuration. Usage: /sandbox [status | on | off | strict | standard | add-writable <path> | deny <path>]',
    handler: async (args, ctx) => {
      const sandbox = await import('../core/sandbox.js')
      const { assertExecutionProfile } = await import('../core/executionBackend.js')
      const parts = args.trim().split(/\s+/).filter(Boolean)
      const sub = parts[0] || 'status'
      const active = ctx.engine.getConfig().executionProfile
      if (sub === 'status') {
        return text(
          `Execution mode: ${active?.mode ?? 'trusted-local'}\nProcess isolation is unavailable; saved sandbox path preferences are not enforced.\n\n` + sandbox.formatConfig(sandbox.loadConfig()),
        )
      }
      if (sub === 'on' || sub === 'enable' || sub === 'strict' || sub === 'standard') {
        try { assertExecutionProfile({ ...active, mode: 'isolated-worker' }) }
        catch (error) { return text(`Cannot enable sandbox: ${error instanceof Error ? error.message : String(error)}`) }
        return text('Sandbox activation requires a supported execution backend.')
      }
      if (sub === 'off' || sub === 'disable') {
        sandbox.updateConfig({ enabled: false })
        ctx.engine.getConfig().executionProfile = { ...active, mode: 'trusted-local' }
        sandbox.invalidateProfileCache()
        return text('Sandbox disabled.')
      }
      if (sub === 'add-writable') {
        const path = parts[1]
        if (!path) return text('Usage: /sandbox add-writable <path>')
        const cfg = sandbox.loadConfig()
        cfg.writablePaths.push(path)
        sandbox.saveConfig(cfg)
        sandbox.invalidateProfileCache()
        return text(`Saved writable path preference: ${path}\nProcess isolation is unavailable; path restrictions are not active.`)
      }
      if (sub === 'deny') {
        const path = parts[1]
        if (!path) return text('Usage: /sandbox deny <path>')
        const cfg = sandbox.loadConfig()
        cfg.deniedPaths.push(path)
        sandbox.saveConfig(cfg)
        sandbox.invalidateProfileCache()
        return text(`Saved denied path preference: ${path}\nProcess isolation is unavailable; path restrictions are not active.`)
      }
      return text(sandbox.formatConfig(sandbox.loadConfig()))
    },
  },
  {
    name: 'sync',
    description:
      'Settings sync. Usage: /sync [status | push-file <path> | pull-file <path> [passphrase] | push-git <repo> | pull-git <repo> [passphrase]]',
    handler: async (args) => {
      const sync = await import('../core/settingsSync.js')
      const parts = args.trim().split(/\s+/).filter(Boolean)
      const sub = parts[0] ?? 'status'
      if (sub === 'status') {
        return text(sync.formatSyncStatus(sync.getSyncStatus()))
      }
      if (sub === 'push-file') {
        const filePath = parts[1]
        if (!filePath) return text('Usage: /sync push-file <path> [passphrase]')
        const passphrase = parts[2]
        const result = sync.syncPush({ transport: 'file', filePath, passphrase })
        return text(sync.formatSyncResult(result))
      }
      if (sub === 'pull-file') {
        const filePath = parts[1]
        if (!filePath) return text('Usage: /sync pull-file <path> [passphrase]')
        const passphrase = parts[2]
        const result = sync.syncPull({
          transport: 'file',
          filePath,
          passphrase,
          force: parts.includes('--force'),
        })
        return text(sync.formatSyncResult(result))
      }
      if (sub === 'push-git') {
        const repo = parts[1]
        if (!repo) return text('Usage: /sync push-git <repo> [passphrase]')
        const passphrase = parts[2]
        const result = sync.syncPush({ transport: 'git', repo, passphrase })
        return text(sync.formatSyncResult(result))
      }
      if (sub === 'pull-git') {
        const repo = parts[1]
        if (!repo) return text('Usage: /sync pull-git <repo> [passphrase]')
        const passphrase = parts[2]
        const result = sync.syncPull({
          transport: 'git',
          repo,
          passphrase,
          force: parts.includes('--force'),
        })
        return text(sync.formatSyncResult(result))
      }
      return text(sync.formatSyncStatus(sync.getSyncStatus()))
    },
  },
  {
    name: 'telemetry',
    description: 'Usage analytics. Usage: /telemetry [stats | on | off | export | clear]',
    handler: async (args) => {
      const tel = await import('../core/telemetry.js')
      const parts = args.trim().split(/\s+/).filter(Boolean)
      const sub = parts[0] ?? 'stats'
      if (sub === 'stats') {
        return text(tel.formatAggregates(tel.getAggregates()))
      }
      if (sub === 'on') {
        const cfg = tel.setEnabled(true)
        return text(tel.formatConfig(cfg))
      }
      if (sub === 'off') {
        const cfg = tel.setEnabled(false)
        return text(tel.formatConfig(cfg))
      }
      if (sub === 'export') {
        const data = tel.exportData()
        return text(JSON.stringify(data.aggregates, null, 2))
      }
      if (sub === 'clear') {
        const n = tel.clearData()
        return text(`Cleared ${n} telemetry events.`)
      }
      return text(tel.formatConfig(tel.loadConfig()))
    },
  },
]
