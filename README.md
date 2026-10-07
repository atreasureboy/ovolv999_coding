# ovolv999 — 超级个人编码工具

<div align="center">

**统一 Harness · 模块化能力 · 流式引擎 · 并发调度 · 三层记忆 · 可组合工具与命令**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%3E%3D22.13.0-339933?logo=node.js)](https://nodejs.org/)

> `ovolv999 "任何你需要它完成的任务"`

</div>

## 简介

ovolv999 是一个面向自主编码的 TypeScript Agent 基座。当前实现保留兼容模型接口，并参考 Codex 的工具路由、审批和执行生命周期划分职责。模块边界见 [逐模块重构说明](docs/module-refinement.md)，最新逐文件修复与验证见 [文件审计记录](docs/file-audit.md)。

所有 Agent 共享同一套运行时（Harness），通过启用/禁用模块获得差异化能力。不存在 `agent_type` 枚举——角色是 `AgentConfig`（identity + modules + tools）的组合配置。

### 核心特性

- **统一 Harness** — 所有 Agent 走同一套 Boot Sequence，按模块配置差异化执行
- **模块化能力** — memory / critic / workspace / reflection 四个可组合模块
- **配置驱动角色** — 探索者、规划者、审查者 = 不同 AgentConfig 配置实例，零代码新增角色
- **三层记忆系统** — Semantic（语义知识）+ Episodic（过程轨迹）+ KnowledgeBase（结构化知识库）
- **来源归因 + 冲突解决** — `user_stated > agent_inferred > tool_observed` 优先级链
- **验证闸门** — 子 agent 完成代码修改后自动按项目 scripts / 语言工具验证（No Tuple, No Merge）
- **并发调度** — 只读/安全工具并行 (Promise.all)，状态工具串行
- **流式引擎** — Streaming LLM API，tool_call 解析 → 分区调度 → 结果注入 → 循环
- **Plan 模式** — `EnterPlanMode` / `ExitPlanMode` / `VerifyPlanExecution` 闭环
- **MCP 客户端** — 默认仅 stdio transport；HTTP/SSE 与 OAuth 未接线，工具以 `mcp__<server>__<tool>` 注入
- **沙箱执行** — 当前支持 trusted-local；isolated-worker 在没有已验证独立执行后端时拒绝启动
- **进程内 LSP** — typescript-language-server / pylsp / rust-analyzer / gopls；缺少可用服务时回退语言检查。tsserver 使用不同协议，不作为 LSP 启动
- **SSH 远程** — SshProfile 管理，rsync 同步，远程 agent 执行
- **后台会话** — `--bg` 启动 detached 会话，`ps/attach/logs/stop/rm/clean` CLI 管理
- **上下文管理** — microCompact + snipCompact + autoCompact 三级策略，含系统提示词 token
- **Budget + Effort** — token 预算控制 + 自动 effort 分级
- **Auto-Classifier** — 自动将用户请求分类为 code/search/debug/general，选择最优 effort
- **Auto-Dream** — 空闲时后台知识整理与经验巩固
- **MagicDocs** — 自动从代码提取项目文档（overview/api/models/config/decisions/patterns/dependencies/tests）
- **遥测** — opt-in 本地分析，14 种事件类型，聚合统计
- **设置同步** — AES-256-GCM 加密，git/file 传输，跨机器配置同步
- **系统健康检查** — 13 项环境检测（Node/API/磁盘/Git/权限等）
- **自动更新** — semver 比较，npm dist-tag 检查，ignore-list
- **缓存统计** — prompt-cache hit/miss 追踪，per-model 分解，成本节约
- **IDE 检测** — 9 种编辑器检测（VSCode/IntelliJ/Vim/Emacs/...），路径转换，扩展推荐
- **生命周期 Hooks** — 6 种：PreToolCall / PostToolCall / OnError / OnComplete / OnContextOverflow / UserPromptSubmit
- **Skill 系统** — frontmatter 解析 + 懒加载 + 语义搜索 + auto-suggestion
- **Plugin 系统** — 动态加载 npm 包/本地路径插件
- **Permission 系统** — allow/deny 规则 + glob 匹配 + 持久化
- **命令历史 + 书签** — 跨 session 命令历史 + 位置书签
- **文件历史 / Rewind** — 每次编辑快照，可回滚
- **ACP 协议** — stdio JSON-RPC adapter，能力由已装配 handler 决定
- **Vim 模式** — normal/insert/visual 模式，keybinding 可定制
- **Ink/React UI** — 可选的 `--ink` 富终端 UI
- **零领域绑定** — 核心是 Agent 基础设施，业务逻辑通过 Module + Tool 插件注入

## 架构全景

```
╔═══════════════════════════════════════════════════════════════════════════╗
║                   ovolv999 — 统一 Harness + 模块化 Agent 基座               ║
║                    Turn 生命周期 · 模块装配 · 工具调度                  ║
║              Runtime: openai · glob · zod · ink · react                     ║
╠═══════════════════════════════════════════════════════════════════════════╣
║                                                                           ║
║  ┌─ AgentConfig ──────────────────────────────────────────────────────┐   ║
║  │  identity(SOUL) + modules[] + tools[] + skills[] + limits           │   ║
║  │  ↓ preset (explore/plan/code-reviewer/general-purpose) 或 custom     │   ║
║  └────────────────────────────────────────────────────────────────────┘   ║
║                                  │                                        ║
║  ┌───────────────────────────────▼────────────────────────────────────┐   ║
║  │                    ExecutionEngine (统一 Harness)                    │   ║
║  │                                                                     │   ║
║  │  ┌─ Boot Sequence (7 steps) ────────────────────────────────────┐  │   ║
║  │  │ 1. applyAgentToConfig  →  合并 agent 配置                      │  │   ║
║  │  │ 2. deriveEnabledModules → 自动推导或显式指定                   │  │   ║
║  │  │ 3. modules.boot()      → 并行启动，收集 prompt/tools/context   │  │   ║
║  │  │ 4. buildSystemPrompt   → 组装 identity + module sections       │  │   ║
║  │  │ 5. getToolDefinitions  → 白名单 + planMode 双重过滤            │  │   ║
║  │  │ 6. buildToolContext    → 基础 + module patches + toolNames     │  │   ║
║  │  │ 7. boot_context 轨迹   → EventLog 记录启动摘要                 │  │   ║
║  │  └────────────────────────────────────────────────────────────────┘  │   ║
║  │                                                                     │   ║
║  │  ┌─ Engine Loop ─────────────────────────────────────────────────┐  │   ║
║  │  │  modules.onIteration()   ← CriticModule 每 N 轮纠错            │  │   ║
║  │  │  autoClassifier()        ← 自动分类请求类型 + effort            │  │   ║
║  │  │  evaluateContextBudget() ← 统一 70%/85% (含系统提示词)         │  │   ║
║  │  │    ├─ 50%: snipCompact   ← 手术式裁剪大 tool result            │  │   ║
║  │  │    ├─ 70%: warn          ← 提醒用户                            │  │   ║
║  │  │    └─ 85%: autoCompact   ← LLM 摘要压缩                        │  │   ║
║  │  │  callLLM() → streaming → consumeStream()                       │  │   ║
║  │  │  partitionToolCalls() → parallel(safe) / serial(stateful)      │  │   ║
║  │  │  executeToolCall() → 白名单 + planMode + 执行边界检查          │  │   ║
║  │  │  modules.onToolCall()   ← MemoryModule 写 episodic             │  │   ║
║  │  │  hooks: PreToolCall / PostToolCall                             │  │   ║
║  │  └────────────────────────────────────────────────────────────────┘  │   ║
║  │                                                                     │   ║
║  │  ┌─ Post-Run ────────────────────────────────────────────────────┐  │   ║
║  │  │  modules.onComplete()  ← ReflectionModule LLM 知识提取         │  │   ║
║  │  │  hooks: OnComplete / OnError / OnContextOverflow               │  │   ║
║  │  │  consolidateSession() ← episodic → SemanticMemory              │  │   ║
║  │  └────────────────────────────────────────────────────────────────┘  │   ║
║  │                                                                     │   ║
║  │  Abort: softAbort(ESC) / hardAbort(Ctrl+C)                         │   ║
║  └─────────────────────────────────────────────────────────────────────┘   ║
║                                                                           ║
║  ┌─ Modules ─────┐  ┌─ Tools ─────────────┐  ┌─ Memory (3 层) ──────┐  ║
║  │ memory         │  │ Bash/Read/Write/Edit │  │ Semantic: 关键词检索  │  ║
║  │ critic         │  │ Glob/Grep/Todo       │  │ Episodic: 工具轨迹    │  ║
║  │ workspace      │  │ Web* /Agent/Skill    │  │ KnowledgeBase: 结构化 │  ║
║  │ reflection     │  │ Plan/Sleep/Snip      │  └──────────────────────┘  ║
║  └────────────────┘  │ Worktree/Goal        │                             ║
║                      │ Brief/CtxInspect     │  ┌─ Integration ─────────┐  ║
║  ┌─ MCP Client ───┐  │ TerminalCapture      │  │ LSP (in-process)      │  ║
║  │ stdio only     │  │ WebBrowser           │  │ SSH Remote            │  ║
║  │ HTTP 未接线    │  │ PushNotification     │  │ Trusted local         │  ║
║  │ Resources      │  │ Task*(5)/Notebook    │  │ Background Sessions   │  ║
║  └────────────────┘  │ ClaudeCode/Diag      │  │ MagicDocs             │  ║
║                      │ MCP Resources(2)     │  │ Telemetry             │  ║
║  ┌─ Commands ────┐  └──────────────────────┘  │ Settings Sync         │  ║
║  │ 按职责分组注册 │                            └──────────────────────┘  ║
║  └───────────────┘                                                      ║
║                                                                           ║
║  输出: sessions/session_TIMESTAMP/ → 会话产物、EventLog、agent-logs       ║
╚═══════════════════════════════════════════════════════════════════════════╝
```

## 核心概念

### Module System — 模块化能力

所有 Agent 共享同一套 Harness，通过启用/禁用模块获得差异化能力：

```typescript
const agentConfig: AgentConfig = {
  identity: { systemPrompt: (cwd) => `你是运维员...` },
  modules: {
    memory: { enabled: true },      // 记忆检索 + memory_write/search/recall 工具
    critic: { enabled: true },      // 每 N 轮 LLM 纠错
    workspace: { enabled: true },   // sessionDir 产物目录
    reflection: { enabled: true },  // Run 结束后知识提取 → SemanticMemory
  },
  tools: ['Bash', 'Read', 'Grep'],
  maxIterations: 50,
}
```

| 模块 | Boot 行为 | 循环行为 | 提供的工具 |
|------|----------|---------|-----------|
| `memory` | 关键词相关性检索注入 top-10 | onToolCall 写 episodic | memory_write / memory_search / memory_recall |
| `critic` | — | onIteration 每 5 轮纠错 | — |
| `workspace` | 注入 sessionDir 到 ToolContext | — | — |
| `reflection` | — | onComplete LLM 知识提取 | — |

### AgentConfig — 配置驱动角色（无 agent_type）

4 个内置 preset + 无限自定义组合：

| 预设 | modules | tools | 场景 |
|------|---------|-------|------|
| `explore` | `{}` | Read/Glob/Grep/Web* (planMode) | 代码探索 |
| `plan` | `{}` | Read/Glob/Grep/Web* (planMode) | 实现规划 |
| `code-reviewer` | `{}` | Read/Glob/Grep (planMode) | 代码审查 |
| `general-purpose` | `{memory,workspace}` | 全工具（排除 Agent 防递归） | 通用子任务 |
| 自定义 | 任意组合 | 任意子集 | 零代码新增角色 |

### Memory System — 三层记忆 + 来源归因 + 整合闭环

```
写入 (memory_write):
  source: user_stated(3) > agent_inferred(2) > tool_observed(1)
  → 同内容冲突: 低优先级不能覆盖高优先级

Boot 时检索:
  userMessage → extractKeywords → scoreRelevance → top-10 注入

Session 整合 (REPL 退出):
  episodic 全量 → LLM 总结 → 高置信度知识 → SemanticMemory (source: consolidation)

跨 Session:
  下次 Boot → 相关性检索 → 自动注入
```

更正已有约定时，先通过 `memory_search` 获取旧记录 ID，再在 `memory_write` 中明确提供 `supersedes`。替代写入会同时保存新 active 记录和旧 superseded 历史；启动注入与检索只使用 active。相似内容不会自动撤销旧记录。`sourceRef` 保留会话、轮次和角色归属声明，但不认证用户身份。

### Verification Gate — 验证闸门 (No Tuple, No Merge)

```typescript
Agent({
  description: "实现登录功能",
  prompt: "...",
  subagent_type: "general-purpose",
  verify: true   // ← 完成后自动跑 package scripts 或语言检查
})
```

验证命令优先读取 `package.json` scripts：`typecheck` 或 `build`、`lint`、`test`。没有 scripts 时按项目类型回退到 `npx tsc --noEmit`、`go vet ./...`、`cargo check` 或 `python -m compileall -q .`。

### 并发分区调度

```
tool_calls [A, B, C, D, E, F]
     │
     ├─ partitionToolCalls()
     │
     ├─ Batch 1 (并行): [A=Read, B=Glob, C=WebSearch]
     │     → Promise.all([A, B, C]) → 同时执行
     │
     ├─ Batch 2 (串行): [D=Write]
     │     → 等 Batch 1 完成 → 执行 D
     │
     └─ 后续调用: [E=Bash, F=Agent]
           → 根据实际只读属性、资源锁和隔离条件决定串行或并行
```

## 工具参考

| 类别 | 工具 | 说明 |
|------|------|------|
| **文件** | Read, Write, Edit, NotebookEdit | 文件读写编辑 + Jupyter notebook |
| **搜索** | Glob, Grep | 文件名匹配 + 内容正则搜索 |
| **执行** | Bash, ShellSession, TmuxSession | 跨平台 shell + 持久会话 |
| **Web** | WebFetch, WebSearch, WebBrowser | URL 抓取 + 搜索 + 结构化 HTML 解析 |
| **Agent** | Agent, ClaudeCode | 子 agent 调用 + 外部 Claude Code worker |
| **Plan** | EnterPlanMode, ExitPlanMode, VerifyPlanExecution | 计划模式闭环 |
| **Task** | TaskCreate, TaskGet, TaskList, TaskUpdate, TaskStop | 后台任务生命周期 |
| **Memory** | memory_write, memory_search, memory_recall | 三原语（MemoryModule 提供） |
| **Worktree** | EnterWorktree, ExitWorktree, ListWorktrees | Git worktree 管理 |
| **Skill** | load_skill, Snip | 技能懒加载 + 上下文裁剪 |
| **诊断** | Diagnostics, Goal, Brief, CtxInspect | LSP 诊断 + 目标 + 会话快照 + token 分析 |
| **通知** | PushNotification, TerminalCapture, Sleep | 系统通知 + tmux 截屏 + 延时 |
| **MCP** | ListMcpResources, ReadMcpResource | MCP 资源读取 |
| **其他** | AskUser, TodoWrite | 用户交互 + 任务清单 |

## 斜杠命令

| 类别 | 命令 |
|------|------|
| **会话** | `/exit` `/clear` `/reset` `/resume` `/sessions` `/status` `/context` `/cost` |
| **上下文** | `/compact` `/snip` `/rewind` `/undo` `/retry` `/export` `/audit` `/snapshot` |
| **模式** | `/mode` `/poor` `/vim` `/style` `/effort` `/budget` `/model` `/models` |
| **工具/权限** | `/permissions` `/config` `/files` `/cwd` `/tasks` `/workers` `/plugins` |
| **搜索/知识** | `/search` `/knowledge` `/skill-save` `/skills` `/suggest` `/cmd-history` `/bookmark` `/snippet` |
| **代码/Git** | `/diff` `/commit` `/git` `/branch` `/metrics` `/diff-browser` `/review` `/security-review` |
| **诊断** | `/doctor` `/health` `/diagnostics` `/hooks` `/goal` `/transcript` `/scan` `/debug-tool-call` |
| **安全/沙箱** | `/sandbox` `/vault` `/permissions` |
| **远程/同步** | `/sync` `/ssh` `/lsp` `/update` `/cache` `/ide` |
| **团队/记忆** | `/team-memory` `/dream` `/messages` `/telemetry` `/magic-docs` |
| **系统** | `/init` `/version` `/copy` `/help` `/history` `/keybindings` `/workflow` `/onboard` `/daemon` `/schedule` `/timer` `/profile` `/notify` `/share` |

## 如何扩展

### 方式 1: 编写自定义 Tool

```typescript
import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'

export class MyCustomTool implements Tool {
  name = 'MyCustom'
  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'MyCustom',
      description: '...',
      parameters: { type: 'object', properties: { /* ... */ }, required: ['input'] },
    },
  }
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    return { content: 'done', isError: false }
  }
}
```

注册到 `src/tools/index.ts` 或通过 `EngineConfig.extraTools` 注入。

### 方式 2: 编写自定义 Module

```typescript
import type { AgentModule, ModuleBootContext, ModuleBootResult } from '../core/module.js'

export class MyModule implements AgentModule {
  readonly name = 'my-module'
  readonly dependencies = ['memory']

  boot(ctx: ModuleBootContext): ModuleBootResult {
    return {
      systemPromptSections: ['## Custom Knowledge\n...'],
      tools: [myCustomTool],
    }
  }

  onToolCall(toolName: string, input: Record<string, unknown>, result: { content: string; isError: boolean }): void {
    // 每次工具调用后的副作用
  }
}
```

注册: `globalModuleRegistry.register('my-module', (ctx) => new MyModule())`

### 方式 3: 自定义 Agent 角色

```typescript
const config: AgentConfig = {
  identity: {
    systemPrompt: (cwd: string) => `Working directory: ${cwd}\n\n你是安全审计员...`,
  },
  modules: { memory: { enabled: true }, workspace: { enabled: true } },
  tools: ['Read', 'Glob', 'Grep', 'Bash'],
  maxIterations: 50,
}

// 通过 Agent 工具的 agent_config 参数使用
Agent({ description: '审计认证模块', prompt: '...', agent_config: config })
```

### 方式 4: 添加自定义 Skill

在 `.opencode/skills/` 下创建 Markdown 文件:

```markdown
---
name: deploy
description: 部署到生产环境
tools: Bash, Read
---
检查 staging 环境，确认测试通过后部署到生产...
```

LLM 可通过 `load_skill("deploy")` 按需加载。支持语义搜索匹配最相关技能。

### 方式 5: 编写 Plugin

```typescript
// my-plugin/index.ts
import type { Plugin } from '../core/plugins.js'

export const plugin: Plugin = {
  name: 'my-plugin',
  version: '1.0.0',
  tools: [myCustomTool],
  modules: [myModule],
  setup(ctx) { /* 初始化 */ },
}
```

通过 `.ovogo/settings.json` 的 `plugins` 字段或 `/plugins` 命令注册。

## 发布与支持边界

当前整改候选面向单机、可信本地用户，要求 Node ≥22.13.0 和本地文件系统。CI 目标矩阵为 Windows/Linux × Node 22.13.0、22.x、24.x；每格需保留实际通过结果，不能用本地 Windows 结果代替 Linux。NFS/SMB、跨主机共享存储、公网多租户隔离不在支持范围；进程内 Plugin/Module 必须视为可信代码。

| 入口 | 实际能力与兼容边界 |
| --- | --- |
| CLI / `--pipe` | CLI 执行受有效权限和验收控制；原始 `--pipe` 只产生文本，不装配写入工具 |
| MCP | 默认 stdio，初始化版本 `2024-11-05`；初始化响应必须确认同一版本及有效 capabilities，否则拒绝连接。其他版本尚未验证。tools/resources/prompts 按已连接服务提供；HTTP/SSE/OAuth 不由默认客户端装配 |
| ACP | 仓库 stdio JSON-RPC adapter，版本 `2025-07-20`；先 initialize，拒绝不支持的版本。没有 handler 的文件读写禁用；能力字段仅描述实际装配，不承诺所有编辑器兼容 |
| 执行隔离 | 支持 trusted-local；要求 isolated-worker 而缺少实际隔离后端时拒绝执行。沙箱策略文件存在不构成操作系统隔离证明 |
| 构建身份 | `ovolv999 --version` 显示版本、源码 SHA 与 dirty 标志；包内 `dist/build-info.json` 提供构建输入哈希 |

从 clean checkout 执行 `pnpm run release:gate`，依次做 frozen install、typecheck、完整 lint/tests、clean build、pack、全新目录冻结安装、已安装命令/协议/恢复冒烟及短时 soak。每次 pack 自动 clean build；任何检查失败都阻断候选发布。现有 lint/test 阻断必须真实修复，不能用局部通过代替整个门禁通过。

详见 [支持矩阵、发布命令、短/长 soak 与回滚步骤](docs/release-support.md)、[实际工具装配](docs/architecture-capabilities.md) 和 [变更日志](CHANGELOG.md)。脚本不会 push、npm publish 或配置远程 branch protection。

## 快速开始

### 安装

```bash
git clone https://github.com/atreasureboy/ovolv999_coding.git
cd ovolv999_coding
pnpm install --frozen-lockfile
pnpm run build
```

使用 `package.json` 声明的 pnpm 版本。Windows 可运行 `setup.bat`，macOS/Linux 可运行 `./setup.sh`；二者共用 `pnpm run setup:local`，每次冻结安装并重建，再链接全局命令。已有 `.env` 保留；失败会中断后续步骤。

### 配置

```bash
export OPENAI_API_KEY="your-key"
# export OPENAI_BASE_URL="https://your-proxy.com/v1"
# export OVOGO_MODEL="claude-sonnet-4-6-20250514"
```

### 使用

```bash
# 交互模式 — REPL
npx tsx bin/ovogogogo.ts

# 单任务模式
npx tsx bin/ovogogogo.ts "修复 src/core 的类型错误"

# 指定模型和工作目录
npx tsx bin/ovogogogo.ts -m claude-sonnet-4-6 --cwd /my/project

# 后台会话模式
npx tsx bin/ovogogogo.ts "长任务" --bg

# 后台会话管理
ovolv999 ps           # 列出所有后台会话
ovolv999 attach <id>  # 附加到后台会话
ovolv999 logs <id>    # 查看日志
ovolv999 stop <id>    # 停止会话
ovolv999 clean        # 清理已终止会话

# 构建后使用全局命令
pnpm run build
pnpm link --global
ovolv999 "任务描述"
```

### 配置文件

CLI 参数优先；项目模型与运行参数来自工作目录向 Git 根查找的首个 `.ovolv999.json` / `.ovolv999.jsonc`，再回退环境变量及默认值。凭据来自环境或 CLI 装载的 `.env`。

权限、Hooks、任务上下文和 MCP 使用 `~/.ovogo/settings.json` 与项目 `.ovogo/settings.json` 分层设置。项目设置覆盖对应用户设置，权限规则与 Hooks 按层追加。`/profile` 等辅助能力的 `.ovolv999/` 存储有各自接口，不自动改写当前引擎参数。

```json
{
  "model": "my-model",
  "permissionMode": "ask",
  "maxIterations": 50,
  "enabledModules": ["memory", "workspace", "critic", "reflection"]
}
```

原生模型协议可在上述项目配置或分层 settings 的 `modelSettings` 中按完整模型名选择：

```json
{
  "model": "my-model",
  "modelSettings": {
    "my-model": {
      "protocol": "responses",
      "capabilities": {
        "tools": true,
        "vision": true,
        "reasoning": true,
        "contextWindow": 128000,
        "maxOutputTokens": 8192
      },
      "effort": {
        "parameter": "reasoning.effort",
        "values": { "low": "low", "medium": "medium", "high": "high" }
      }
    }
  }
}
```

这些能力、窗口和 effort 值必须符合所用模型与服务。协议支持 `chat-completions`、`responses`、`anthropic`；省略时保留兼容入口，也可用 `OVOGO_MODEL_PROTOCOL` 设置环境默认。Anthropic 原生入口使用 `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`，地址来自 `ANTHROPIC_BASE_URL`；OpenAI 协议使用原有 `OPENAI_*` 环境。MiniMax 默认保留原兼容转换。`/effort` 在配置了参数映射后进入原生请求，缺少映射时不会猜测参数。历史保留原生续接状态，裁剪后显式重新建立续接。

费用统计覆盖主请求、摘要、critic/reflection 和子代理，未知用量或缓存单价会显示未知费用。内置历史价格不是最新账单保证；需要精确单价时，在对应模型下设置含 `version`、`inputPer1M`、`outputPer1M` 及可选缓存读写单价的 `pricing`。`pnpm run eval:offline` 用 12 个确定性临时仓库任务验证实际工具链，完整说明见 [发布与基线说明](docs/release-support.md)。

项目 `.ovogo/settings.json` 示例：

```json
{
  "permissions": {
    "mode": "default",
    "rules": [{ "toolName": "Read", "behavior": "allow", "ruleContent": "*", "source": "project" }]
  },
  "mcp": {
    "servers": [{ "name": "my-server", "type": "stdio", "command": ["my-mcp-server"] }]
  },
  "executionPolicy": {
    "mode": "trusted-local",
    "envAllowlist": ["CI"],
    "limits": { "processes": 8 }
  }
}
```

执行策略按用户设置、项目设置和项目运行配置合并；省略字段继承，显式数组替换。managed 命令、MCP、异步 Hooks 和验收命令默认只获得平台必需环境；项目需要额外变量时通过 `envAllowlist` 明确提供，MCP 的显式 `env` 只授予对应服务。Windows x64 的非 IPC managed 启动通过原生 Job Object 包含进程树，先挂起创建、确认加入再运行，物理关闭后才释放容量；未知关闭状态继续占用。IPC、非 Windows 和未迁移的同步辅助入口不具有此保证。`trusted-local` 没有内核文件或网络隔离；隔离模式、非空文件根限制、网络限制和内存/CPU 配额目前会在启动前拒绝。已有配置文件无法读取或不是有效对象时，启动报告文件路径并停止。

交互 REPL 的批准可选一次或本次会话中的相同完整操作，绑定工具、参数、目录和有效策略；设置变化后需要重新审批。单次任务、loop 和无界面入口没有审批 host，需要批准时返回 `needs_input`。当前没有新规则持久化、远程审批或审批重连功能。

## 项目结构

```
ovolv999/
├── bin/ovogogogo.ts                  # CLI 装配入口
├── src/
│   ├── cli/                         # 参数、环境、路径、单任务与交互会话
│   ├── core/
│   │   ├── engine.ts / engine/       # turn 调度、策略、流解析、结果验收
│   │   ├── compact.ts / compact/     # 压缩策略、预算与 token 估算
│   │   ├── providers.ts / providers/ # 兼容导出、元数据、识别与能力
│   │   ├── model/ / modelRuntime.ts  # 协议适配、能力与原生续接
│   │   ├── usageLedger.ts           # 请求与 run family 的持久用量
│   │   ├── managedProcess.ts        # 进程归属、物理关闭与原始字节
│   │   └── *.ts                     # 运行状态、持久化、进程、权限及独立能力
│   ├── commands/
│   │   ├── builtin.ts               # 一处注册装配，保留有效顺序和别名
│   │   └── *Commands.ts             # 按职责分组的命令处理
│   ├── config/settings.ts / settings/ # 读取保存、规范化、分层与补丁合并
│   ├── tools/                       # 工具规则及文件/输出共享步骤
│   ├── modules/                     # memory、critic、workspace、reflection、mcp
│   ├── integrations/acp.ts / acp/    # RPC 调度、协议规则与输入组帧
│   ├── integrations/pipeMode.ts      # 管道模式
│   ├── ui/ink/                      # 会话 controller、状态 store 与展示组件
│   ├── ui/                          # readline、Renderer、输入与历史裁剪
│   ├── skills/                      # 发现、加载与提取
│   ├── prompts/                     # 提示词
│   └── utils/                       # 独立工具函数
├── tests/                           # 行为回归测试；新增用例对应源码目录
├── scripts/                         # clean build、安装后验收与发布门禁
├── native/execution-host/           # Windows Job 宿主源文件和构建
└── docs/module-refinement.md         # 入口职责、修复依据与本轮验证
```

## AgentOS 概念对照

| AgentOS 概念 | ovolv999 实现 |
|---|---|
| 统一 Harness（无 agent_type） | `ExecutionEngine` + `AgentConfig` + 4 preset |
| 模块组合驱动 | `ModuleRegistry` + memory/critic/workspace/reflection |
| Boot Sequence | 7 步：identity → modules → boot → prompt → tools → context → trajectory |
| 来源归因 + 冲突解决 | `user_stated(3) > agent_inferred(2) > tool_observed(1)` |
| Memory 三原语 | `memory_write` / `memory_search` / `memory_recall` |
| 三层记忆 | Semantic + Episodic + KnowledgeBase |
| Boot 时相关性检索 | `extractKeywords` + `scoreRelevance` → top-10 |
| Memory 整合 | `consolidateSession` — REPL 退出时 LLM 总结 |
| Skill 系统 | frontmatter 解析 + 懒加载 + 语义搜索 + auto-suggest |
| 验证闸门 (No Tuple No Merge) | `verify:true` → 自动 package scripts / 语言检查 |
| 调用链追踪 + 循环检测 | `_callDepth` max 5 + EventLog |
| 生命周期 Hooks | 6 种 Hook 类型 |
| Context 压缩 + 策略 | microCompact + snipCompact + autoCompact（含系统提示词 token） |
| Tool metadata | `readOnly` / `concurrencySafe` / `mutatesState` / `longRunning` / `requiresNetwork` |
| 权限系统 | `PermissionManager` + glob 规则 + `/permissions` 持久化 |
| 执行边界 | trusted-local；isolated-worker 缺少已验证后端时 fail closed |
| 后台任务 | `TaskCreate/Get/List/Update/Stop` + Bash background |
| 后台会话 | `--bg` + `ps/attach/logs/stop/rm/clean` CLI |
| MCP 客户端 | 默认 stdio + tools/resources/prompts；HTTP/SSE/OAuth 未接线 |
| 进程内 LSP | typescript-language-server/pylsp/rust-analyzer/gopls JSON-RPC 2.0 |
| SSH 远程 | SshProfile + rsync 同步 + remote agent |
| API 重试 | SDK 隐藏重试关闭；网关有界重试与流中断边界见行为测试 |
| 模块化插件 | Plugin 接口 + `/plugins` 动态加载 |

## 技术栈

| 组件 | 技术 |
|------|------|
| 语言 | TypeScript 5.7 (ESM, strict) |
| 运行时 | Node.js ≥ 22.13.0 |
| LLM API | OpenAI SDK (兼容 Claude/GPT/本地端点) |
| 终端 UI | Ink + React（可选 `--ink`）/ readline REPL（默认） |
| 测试 | Vitest；执行结果见重构与发布验收记录 |
| Lint | ESLint (typescript-eslint recommendedTypeChecked) |
| 运行时依赖 | openai · glob · zod · ink · react (5 个) |

## 构建

```bash
npm run build          # tsc → dist/
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
npm run test           # vitest run
npm run test:watch     # vitest watch
```

## 许可

MIT License
