/**
 * Project context detector — auto-detects project type, scripts, git state.
 * Injected into system prompt so the LLM knows what it's working with.
 */

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'

export interface ProjectContext {
  language?: string
  packageManager?: string
  scripts?: {
    build?: string
    test?: string
    lint?: string
    format?: string
    dev?: string
  }
  framework?: string
  git?: {
    branch?: string
    modifiedCount?: number
    stagedCount?: number
    recentCommits?: string[]
  }
}

function tryReadJSON(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function tryExec(cmd: string, cwd: string): string | null {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim()
  } catch {
    return null
  }
}

/** Detect project context from cwd */
export function detectProjectContext(cwd: string): ProjectContext {
  const ctx: ProjectContext = {}

  // Package.json
  const pkgPath = join(cwd, 'package.json')
  if (existsSync(pkgPath)) {
    const pkg = tryReadJSON(pkgPath)
    if (pkg) {
      ctx.language = 'TypeScript/JavaScript'

      // Detect scripts
      const scripts = pkg.scripts as Record<string, string> | undefined
      if (scripts) {
        ctx.scripts = {
          build: scripts.build,
          test: scripts.test,
          lint: scripts.lint,
          format: scripts.format,
          dev: scripts.dev,
        }
      }

      // Detect framework
      const deps = { ...(pkg.dependencies as Record<string, string> ?? {}), ...(pkg.devDependencies as Record<string, string> ?? {}) }
      if (deps.next) ctx.framework = 'Next.js'
      else if (deps.vite) ctx.framework = 'Vite'
      else if (deps.react) ctx.framework = 'React'
      else if (deps.express) ctx.framework = 'Express'
      else if (deps.fastapi ?? deps.flask) ctx.framework = 'Python Web'
    }
  }

  // Package manager
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) ctx.packageManager = 'pnpm'
  else if (existsSync(join(cwd, 'yarn.lock'))) ctx.packageManager = 'yarn'
  else if (existsSync(join(cwd, 'package-lock.json'))) ctx.packageManager = 'npm'
  else if (existsSync(join(cwd, 'bun.lockb'))) ctx.packageManager = 'bun'

  // TypeScript
  if (existsSync(join(cwd, 'tsconfig.json'))) ctx.language = 'TypeScript'

  // Python
  if (existsSync(join(cwd, 'pyproject.toml')) || existsSync(join(cwd, 'setup.py'))) {
    ctx.language = 'Python'
  }

  // Go
  if (existsSync(join(cwd, 'go.mod'))) ctx.language = 'Go'

  // Rust
  if (existsSync(join(cwd, 'Cargo.toml'))) ctx.language = 'Rust'

  // Git
  const gitBranch = tryExec('git branch --show-current', cwd)
  if (gitBranch) {
    const status = tryExec('git status --porcelain', cwd)
    const modified = status ? status.split('\n').filter(l => l.trim().startsWith(' M') || l.trim().startsWith('MM')).length : 0
    const staged = status ? status.split('\n').filter(l => l.trim().startsWith('M') || l.trim().startsWith('A')).length : 0
    const log = tryExec('git log --oneline -3', cwd)
    const commits = log ? log.split('\n').filter(Boolean) : []

    ctx.git = {
      branch: gitBranch,
      modifiedCount: modified,
      stagedCount: staged,
      recentCommits: commits,
    }
  }

  return ctx
}

/** Format project context as a system prompt section */
export function formatProjectContext(ctx: ProjectContext): string {
  const lines: string[] = ['# 项目上下文 (Auto-detected)']

  if (ctx.language) lines.push(` - 语言: ${ctx.language}`)
  if (ctx.framework) lines.push(` - 框架: ${ctx.framework}`)
  if (ctx.packageManager) lines.push(` - 包管理器: ${ctx.packageManager}`)

  if (ctx.scripts) {
    const s = ctx.scripts
    const scripts: string[] = []
    if (s.build) scripts.push(`build: \`${s.build}\``)
    if (s.test) scripts.push(`test: \`${s.test}\``)
    if (s.lint) scripts.push(`lint: \`${s.lint}\``)
    if (s.format) scripts.push(`format: \`${s.format}\``)
    if (s.dev) scripts.push(`dev: \`${s.dev}\``)
    if (scripts.length > 0) {
      lines.push(` - 常用命令:`)
      for (const sc of scripts) lines.push(`   - ${sc}`)
    }
  }

  if (ctx.git) {
    lines.push('')
    lines.push('## Git 状态')
    lines.push(` - 分支: ${ctx.git.branch}`)
    if (ctx.git.modifiedCount! > 0) lines.push(` - 未暂存修改: ${ctx.git.modifiedCount} 个文件`)
    if (ctx.git.stagedCount! > 0) lines.push(` - 已暂存: ${ctx.git.stagedCount} 个文件`)
    if (ctx.git.recentCommits && ctx.git.recentCommits.length > 0) {
      lines.push(` - 最近提交:`)
      for (const c of ctx.git.recentCommits) lines.push(`   - ${c}`)
    }
  }

  return lines.length > 1 ? lines.join('\n') : ''
}
