import type { Command } from './index.js'
import { text } from './results.js'
import { resolve } from 'path'
import type { KnowledgeCategory } from '../core/knowledgeBase.js'

export const knowledgeCommands: Command[] = [
  {
    name: 'skills',
    description: 'List available skills',
    handler: (_args, ctx) => text(ctx.getSkillsText?.() ?? 'No skills available.'),
  },
  {
    name: 'skill-save',
    description:
      'Extract a reusable skill from the current session. Usage: /skill-save <name> [description]',
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/)
      const name = parts[0]
      const description = parts.slice(1).join(' ')
      if (!name) {
        return text(
          'Usage: /skill-save <name> [description]\n\nThe skill will be extracted from the current session and saved to .ovolv999/skills/<name>.md',
        )
      }
      const { extractSkill, saveSkill, skillExists } = await import('../skills/extractor.js')
      if (skillExists(ctx.cwd, name)) {
        return text(
          `⚠ Skill "${name}" already exists. Use a different name or delete the file first.`,
        )
      }
      if (ctx.history.length === 0) {
        return text(
          'No conversation history to extract from. Have a conversation first, then save.',
        )
      }
      try {
        const extraction = extractSkill(ctx.history, {
          name,
          description: description || undefined,
        })
        const path = saveSkill(ctx.cwd, extraction)
        const lines = [
          `✓ Saved skill: ${name}`,
          `  File: ${path}`,
          `  Category: ${extraction.category}`,
          `  Tools used: ${extraction.toolSequence.length} call(s) across ${extraction.turnCount} turn(s)`,
          '',
          `Description: ${extraction.description}`,
          '',
          `Use /${name} to invoke it. Edit the file to customize the prompt.`,
        ]
        return text(lines.join('\n'))
      } catch (err) {
        return text(`Failed to save skill: ${(err as Error).message}`)
      }
    },
  },
  {
    name: 'knowledge',
    aliases: ['kb'],
    description:
      'Project knowledge base. Usage: /knowledge [add <cat> <key> <val> | search <q> | remove <key> | list | stats]',
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/)
      const sub = parts[0] ?? 'list'
      const {
        loadKnowledge,
        addEntry,
        removeEntry,
        searchKnowledge,
        formatKnowledgeList,
        formatSearchResults,
        formatStats,
        extractKnowledgeFromText,
        CATEGORY_ICONS,
      } = await import('../core/knowledgeBase.js')
      if (sub === 'list' || !sub) {
        const store = loadKnowledge(ctx.cwd)
        return text(formatKnowledgeList(store.entries))
      }
      if (sub === 'stats') {
        const store = loadKnowledge(ctx.cwd)
        return text(formatStats(store))
      }
      if (sub === 'add') {
        const category = parts[1]
        const key = parts[2]
        const value = parts.slice(3).join(' ')
        if (!category || !Object.hasOwn(CATEGORY_ICONS, category) || !key || !value) {
          return text(
            'Usage: /knowledge add <category> <key> <value>\nCategories: file, pattern, decision, gotcha, dependency, convention, architecture, general',
          )
        }
        const entry = addEntry(ctx.cwd, category as KnowledgeCategory, key, value)
        return text(`✓ ${entry.category} entry saved: ${entry.key}`)
      }
      if (sub === 'search') {
        const query = parts.slice(1).join(' ')
        if (!query) return text('Usage: /knowledge search <query>')
        const results = searchKnowledge(ctx.cwd, query)
        return text(formatSearchResults(results, query))
      }
      if (sub === 'remove' || sub === 'delete') {
        const key = parts[1]
        if (!key) return text('Usage: /knowledge remove <key or id>')
        const success = removeEntry(ctx.cwd, key)
        return text(success ? `✓ Removed: ${key}` : `⚠ Not found: ${key}`)
      }
      if (sub === 'extract') {
        const text_content = ctx.history
          .map((m) => (typeof m.content === 'string' ? m.content : ''))
          .join('\n')
        const suggestions = extractKnowledgeFromText(text_content)
        if (suggestions.length === 0) return text('No knowledge patterns found in conversation.')
        const lines = suggestions.map(
          (s, i) =>
            `${i + 1}. [${s.category}] ${s.key}: ${s.value.slice(0, 80)} (${Math.round(s.confidence * 100)}%)`,
        )
        return text(`Found ${suggestions.length} potential knowledge:\n${lines.join('\n')}`)
      }
      return text(
        `Unknown subcommand: ${sub}\nUsage: /knowledge [list|add|search|remove|stats|extract]`,
      )
    },
  },
  {
    name: 'bookmark',
    aliases: ['bm', 'mark'],
    description:
      'Manage file/line bookmarks. Usage: /bookmark [add|list|search|remove|visit|stats|recent|file <path>]',
    handler: async (args, ctx) => {
      const {
        addBookmark,
        removeBookmark,
        visitBookmark,
        getBookmarksByFile,
        searchBookmarks,
        getRecentBookmarks,
        formatBookmarkList,
        formatBookmarkDetail,
        formatBookmarkStats,
        loadBookmarks,
      } = await import('../core/bookmarks.js')
      const parts = args.trim().split(/\s+/)
      const sub = parts[0] ?? 'list'
      if (sub === 'add') {
        const loc = parts[1]
        const note = parts.slice(2).join(' ') || '(no note)'
        if (!loc) return text('Usage: /bookmark add <path:line> [note]')
        const match = loc.match(/^(.+?)(?::(\d+)(?:-(\d+))?)?$/)
        if (!match) return text('Invalid path format. Use file.ts:line')
        const filePath = match[1]
        const line = parseInt(match[2] ?? '1', 10)
        const endLine = match[3] ? parseInt(match[3], 10) : undefined
        const bm = addBookmark(ctx.cwd, filePath, line, note, { endLine })
        return text(`✓ Bookmark added: ${filePath}:${line}\n  "${note}"\n  id: ${bm.id}`)
      }
      if (sub === 'remove' || sub === 'rm') {
        const target = parts.slice(1).join(' ')
        if (!target) return text('Usage: /bookmark remove <id|note>')
        const ok = removeBookmark(ctx.cwd, target)
        return text(ok ? '✓ Bookmark removed' : 'No matching bookmark found')
      }
      if (sub === 'visit' || sub === 'go') {
        const id = parts[1]
        if (!id) return text('Usage: /bookmark visit <id>')
        const bm = visitBookmark(ctx.cwd, id)
        if (!bm) return text('Bookmark not found')
        return text(formatBookmarkDetail(bm, ctx.cwd))
      }
      if (sub === 'search') {
        const query = parts.slice(1).join(' ')
        const results = searchBookmarks(ctx.cwd, query)
        return text(formatBookmarkList(results, ctx.cwd))
      }
      if (sub === 'file') {
        const filePath = parts[1]
        if (!filePath) return text('Usage: /bookmark file <path>')
        const results = getBookmarksByFile(ctx.cwd, filePath)
        return text(formatBookmarkList(results, ctx.cwd))
      }
      if (sub === 'recent') {
        const results = getRecentBookmarks(ctx.cwd, 10)
        return text(formatBookmarkList(results, ctx.cwd))
      }
      if (sub === 'stats') {
        const store = loadBookmarks(ctx.cwd)
        return text(formatBookmarkStats(store))
      }
      if (sub === 'list' || !sub) {
        const store = loadBookmarks(ctx.cwd)
        return text(formatBookmarkList(store.bookmarks, ctx.cwd))
      }
      return text(`Usage: /bookmark [add|list|search|remove|visit|stats|recent|file]`)
    },
  },
  {
    name: 'snippet',
    aliases: ['snip', 'code'],
    description:
      'Manage code snippets. Usage: /snippet [add|list|use|search|show|remove|fav|stats]',
    handler: async (args, ctx) => {
      const {
        addSnippet,
        removeSnippet,
        getSnippet,
        listSnippets,
        useSnippet,
        toggleFavorite,
        searchSnippets,
        getCategories,
        getSnippetStats,
        formatSnippet,
        formatSnippetList,
        formatSnippetStats,
      } = await import('../core/snippets.js')
      const parts = args.trim().split(/\s+/)
      const sub = parts[0] ?? 'list'
      if (sub === 'add') {
        const name = parts[1]
        const language = parts[2] ?? 'text'
        const body = parts.slice(3).join(' ')
        if (!name || !body) {
          return text('Usage: /snippet add <name> <language> <body...>\nVariables: {{varName}}')
        }
        const s = addSnippet(ctx.cwd, { name, language, body })
        return text(`✓ Snippet saved: ${s.name} (${s.language})`)
      }
      if (sub === 'use') {
        const name = parts[1]
        if (!name) return text('Usage: /snippet use <name> [key=value ...]')
        const vars: Record<string, string> = {}
        for (const part of parts.slice(2)) {
          const [k, ...v] = part.split('=')
          if (k && v.length) vars[k] = v.join('=')
        }
        const body = useSnippet(ctx.cwd, name, vars)
        if (!body) return text('Snippet not found')
        return text(body)
      }
      if (sub === 'remove' || sub === 'rm') {
        const target = parts[1]
        if (!target) return text('Usage: /snippet remove <name>')
        return text(removeSnippet(ctx.cwd, target) ? '✓ Removed' : 'Not found')
      }
      if (sub === 'show') {
        const target = parts[1]
        if (!target) return text('Usage: /snippet show <name>')
        const s = getSnippet(ctx.cwd, target)
        if (!s) return text('Snippet not found')
        return text(formatSnippet(s))
      }
      if (sub === 'search') {
        const query = parts.slice(1).join(' ')
        const results = searchSnippets(ctx.cwd, query)
        return text(formatSnippetList(results))
      }
      if (sub === 'fav' || sub === 'favorite') {
        const target = parts[1]
        if (!target) return text('Usage: /snippet fav <name>')
        const s = toggleFavorite(ctx.cwd, target)
        return s
          ? text(`✓ ${s.name}: ${s.favorite ? '★ favorited' : 'unfavorited'}`)
          : text('Not found')
      }
      if (sub === 'stats') {
        return text(formatSnippetStats(getSnippetStats(ctx.cwd)))
      }
      if (sub === 'categories') {
        const cats = getCategories(ctx.cwd)
        return text(cats.length > 0 ? `Categories: ${cats.join(', ')}` : 'No categories.')
      }
      if (sub === 'list' || !sub) {
        const filter: {
          favoriteOnly?: boolean
        } = {}
        if (parts[1] === '--fav' || parts[1] === '-f') filter.favoriteOnly = true
        return text(formatSnippetList(listSnippets(ctx.cwd, filter)))
      }
      return text(`Usage: /snippet [add|list|use|search|show|remove|fav|stats|categories]`)
    },
  },
  {
    name: 'team-memory',
    aliases: ['teammem'],
    description:
      'Manage team memory sync. Usage: /team-memory [init <url> | status | sync | files | add <file> | enable-auto | disable-auto]',
    handler: async (args, ctx) => {
      const teamMemModule = await import('../core/teamMemory.js')
      const {
        loadTeamConfig,
        saveTeamConfig,
        syncTeamMemory,
        findMemoryFiles,
        formatSyncResult,
        formatTeamMemoryStatus,
      } = teamMemModule
      const parts = args.trim().split(/\s+/)
      const sub = parts[0] ?? 'status'
      if (sub === 'init') {
        const url = parts[1]
        if (!url) return text('Usage: /team-memory init <git-remote-url>')
        const files = findMemoryFiles(ctx.cwd)
        saveTeamConfig({ remoteUrl: url, files, autoSync: false })
        return text(
          `Team memory initialized:\n  Remote: ${url}\n  Files: ${files.length > 0 ? files.join(', ') : '(none found)'}`,
        )
      }
      if (sub === 'status') {
        return text(formatTeamMemoryStatus())
      }
      if (sub === 'sync') {
        const result = syncTeamMemory()
        return text(formatSyncResult(result))
      }
      if (sub === 'files') {
        const config = loadTeamConfig()
        if (!config) return text('Not configured. Use /team-memory init <url>')
        return text(config.files.length > 0 ? config.files.join('\n') : 'No files configured')
      }
      if (sub === 'add') {
        const file = parts[1]
        if (!file) return text('Usage: /team-memory add <file-path>')
        const config = loadTeamConfig() ?? { remoteUrl: '', files: [] }
        const resolved = resolve(ctx.cwd, file)
        if (!config.files.includes(resolved)) {
          config.files.push(resolved)
          saveTeamConfig(config)
        }
        return text(`Added: ${resolved}`)
      }
      return text(formatTeamMemoryStatus())
    },
  },
  {
    name: 'dream',
    aliases: ['learn', 'patterns'],
    description:
      'Auto-dream and skill learning. Usage: /dream [stats | patterns | log | knowledge | skills | insight <text>]',
    handler: async (args) => {
      const dreamMod = await import('../core/autoDream.js')
      const {
        getTopPatterns,
        getDreamLog,
        getKnowledge,
        getExtractedSkills,
        dream,
        formatPatterns,
        formatDreamLog,
        formatDreamStats,
      } = dreamMod
      const parts = args.trim().split(/\s+/)
      const sub = parts[0] ?? 'stats'
      if (sub === 'stats') {
        return text(formatDreamStats())
      }
      if (sub === 'patterns') {
        return text(formatPatterns(getTopPatterns(10)))
      }
      if (sub === 'log') {
        const limit = parseInt(parts[1] ?? '10', 10)
        return text(formatDreamLog(getDreamLog(limit)))
      }
      if (sub === 'knowledge') {
        const kb = getKnowledge()
        if (kb.length === 0) return text('No knowledge entries yet.')
        const lines = kb.map((k) => `Q: ${k.question}\nA: ${k.answer}`)
        return text(lines.join('\n---\n'))
      }
      if (sub === 'skills') {
        const skills = getExtractedSkills()
        if (skills.length === 0) return text('No skills extracted yet.')
        return text(skills.map((s) => `${s.skillName}: ${s.description}`).join('\n'))
      }
      if (sub === 'insight') {
        const desc = parts.slice(1).join(' ')
        if (!desc) return text('Usage: /dream insight <description>')
        const entry = dream('insight', 'manual', desc)
        return text(`Recorded insight: ${entry.description}`)
      }
      return text('Usage: /dream [stats | patterns | log | knowledge | skills | insight <text>]')
    },
  },
  {
    name: 'messages',
    aliases: ['msg'],
    description:
      'Inter-agent messaging. Usage: /messages [agents | send <to> <msg> | list | stats]',
    handler: async (args) => {
      const msgMod = await import('../core/messageBus.js')
      const { getMessageBus, formatAgentList, formatMessageList, formatBusStats } = msgMod
      const parts = args.trim().split(/\s+/)
      const sub = parts[0] ?? 'stats'
      const bus = getMessageBus()
      if (sub === 'agents') {
        return text(formatAgentList(bus.listAgents()))
      }
      if (sub === 'list') {
        return text(formatMessageList(bus.getMessages()))
      }
      if (sub === 'stats') {
        return text(formatBusStats(bus.getStats()))
      }
      return text('Usage: /messages [agents | list | stats]')
    },
  },
]
