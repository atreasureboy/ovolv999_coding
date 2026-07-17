# PLAN — ovolv999 迭代总体架构方案

> 目标：参考 `claude-code/`（CCB v2.8.3 逆向）把 ovolv999 迭代成"超级个人 coding 工具"。
> 架构师：glm-5.2（指挥）；实现：通过 `claude -p`（M3）委托；状态：`.loop/STATE.md`。
> 证据基线：build(tsc) 通过 / 941 测试通过 / 参考路径已逐一核实存在。

---

## 1. 最终目标与可验证完成标准

**目标**：在不破坏现有 941 测试、不放弃"统一 Harness + 模块化"内核的前提下，分迭代为 ovolv999 增补 CCB 中对"个人 token 受限用户"价值最高的能力，使其成为可日常依赖的超级 coding 工具。

**可验证完成标准**（每条须附证据）：
- C1 `pnpm build` 仍 0 error；`pnpm test` 仍全绿且退出码 0。
- C2 新增能力均有 ≥1 个 vitest 用例覆盖核心路径。
- C3 每个新能力可通过配置/模块开关关闭（默认行为可定义），不影响 bare 核心路径（`ovolv999 "<task>"` 单任务模式仍可用）。
- C4 Poor/Budget 模式开启后，单任务 token 消耗可量化下降（附带 cost 对比证据）。
- C5 MCP 客户端可连接至少一个 stdio MCP server 并把其工具注入工具集（端到端）。
- C6 无新增 P0/P1；PLAN 目标架构与最终实现基本一致。

---

## 2. 当前架构摘要（ovolv999）

- **入口** `bin/ovogogogo.ts`（1565行）：CLI + REPL + 模块注册 + session 整合。
- **核心 Harness** `src/core/engine.ts`（1604行）：7 步 Boot Sequence + Engine Loop（modules.onIteration → evaluateContextBudget → callLLM streaming → partitionToolCalls → executeToolCall → modules.onToolCall → hooks）+ Post-Run（modules.onComplete + hooks）。
- **模块系统** `src/core/module.ts` + `moduleRegistry.ts`（工厂注册 + 依赖解析 + 环检测）；4 内置模块 `src/modules/{memory,critic,workspace,reflection}.ts`。
- **角色** `src/core/agentPresets.ts`：explore/plan/code-reviewer/general-purpose。
- **工具** `src/tools/`（26 个），元信息（readOnly/concurrencySafe/mutatesState/longRunning/requiresNetwork）驱动 `partitionToolCalls`。
- **权限** `src/core/permissionSystem.ts`；**后台任务** `backgroundTaskManager.ts`；**Claude worker** `claudeCodeWorkerManager.ts`（tmux 指挥本机 claude CLI）。
- **记忆** `semanticMemory.ts`（来源归因 + hash 去重）+ `episodicMemory.ts`。
- **压缩/成本** `compact.ts`（70/85%）+ `costTracker.ts`。
- **配置** `src/config/{settings,hooks,ovogomd,projectContext}.ts`；**提示词** `src/prompts/{system,tools,critic}.ts`；**UI** `src/ui/{renderer,input,tmuxLayout,...}.ts`；**技能** `src/skills/loader.ts`。
- **LLM 接入**：仅 openai SDK（`OPENAI_API_KEY`/`OPENAI_BASE_URL`/`OVOGO_MODEL`）。

## 3. 当前架构与目标的差距

| 维度 | 现状 | 目标（个人超级 coding 工具） | 差距 |
|---|---|---|---|
| LLM Provider | 仅 OpenAI 兼容 | 至少能跑通 Gemini/Grok/Anthropic 原生 | 中（SDK 耦合在 callLLM） |
| 能力开关 | module + AgentConfig（粒度中） | 细粒度 feature() 门控 | 中（暂不缺，多特性后才需） |
| 工具集 | 26 | Plan 工具 / MCP / Cron / Worktree 等 | 高 |
| 省 token | costTracker 统计，无主动裁剪 | Poor 模式跳过非必要 LLM 调用 | 高（直接命中用户痛点） |
| 工具生态 | 无 MCP | MCP client 动态接入外部工具 | 高（"超级"差异点） |
| 后台运行 | backgroundTaskManager（进程级） | daemon / --bg 会话 | 低（个人工具非必需） |
| TUI | 基础 renderer | Ink 富组件 | 低（P2，不阻断） |

## 4. 建议的目标架构（增量式，非重写）

**核心原则**：保留 ovolv999 现有内核（Harness + Module + AgentConfig），用"模块 / 配置 / 适配器"三个既有扩展点接入新能力，不引入新框架。

```
                      ┌──────────────────────────────────────────┐
                      │           ExecutionEngine (不变)           │
                      │  Boot → Loop(partition→exec) → PostRun     │
                      └─────────────────────┬────────────────────┘
                                            │ 工具集 / 模块 / Provider
   ┌──────────────────────┬─────────────────┼────────────────┬───────────────────┐
   ▼                      ▼                 ▼                ▼                   ▼
[Provider 适配层]   [Poor 预算模块]   [Plan 工具组]    [MCP 模块+工具]      [FeatureFlag(按需)]
 src/core/llm*      src/modules/poor  src/tools/plan*  src/modules/mcp +    仅当 ≥3 个能力需要
 model-provider     接 costTracker    接 planMode      src/tools/mcp*       门控时再抽象
(openai/gemini/grok) 复用现有 module  复用现有 modes   仿 packages/mcp-client
```

## 5. 分层与模块职责

- **Provider 层（新）**：`src/core/llm/` 下抽象 `LLMProvider` 接口（callLLM 的可替换实现）。现有 openai 调用迁为 `OpenAIProvider`；新增 `GeminiProvider`/`GrokProvider`/`AnthropicProvider`。Engine 经 `config.provider` 选择，**默认仍 openai**（向后兼容）。
- **Poor 模块（新）**：`src/modules/poor.ts`，实现 AgentModule。`onIteration` 前置判断：开启时跳过 critic 纠错、reflection 提取、prompt suggestion 等非必要 LLM 调用；保留主循环与工具执行。复用 `costTracker` 输出节省量。
- **Plan 工具组（新）**：`src/tools/{enterPlanMode,exitPlanMode,verifyPlanExecution}.ts`，与现有 `src/core/modes.ts`(planMode) + `src/tools/exitPlanMode.ts` 对齐，补全 Enter/Verify。
- **MCP 模块（新）**：`src/modules/mcp.ts`（boot 时按配置连接 MCP server，收集工具 → 注入 ToolContext）+ `src/tools/mcp/{call,listResources,readResource}.ts`。传输先实现 stdio，SSE 后续。
- **FeatureFlag（延后）**：首轮不建。改用 config + module enabled 控制。当门控需求累积再抽 `src/core/featureFlag.ts`。

## 6. 模块依赖关系

```
ExecutionEngine
  ├─ LLMProvider (接口) ── OpenAIProvider(默认) / Gemini / Grok / Anthropic
  ├─ ModuleRegistry
  │    ├─ MemoryModule (现有, 依赖 SemanticMemory)
  │    ├─ CriticModule (现有)
  │    ├─ WorkspaceModule (现有)
  │    ├─ ReflectionModule (现有, 依赖 Memory)
  │    ├─ PoorModule (新, 独立, 可门控 Critic/Reflection)
  │    └─ McpModule (新, 独立, 注入 tools)
  └─ Tools (静态注册) + McpModule 动态注入
```
依赖方向：Engine → {Provider, Module, Tool}；模块之间仅 PoorModule 对 Critic/Reflection 有"门控"语义（弱依赖，通过 Engine 配置传递，不硬引用）。

## 7. 关键数据流

- **单任务模式**：`bin/ovogogogo.ts "<task>"` → 解析 flags → 选 Provider → 建 Engine(agents config) → Boot(modules 并行) → Loop → 退出（session 整合，可被 Poor 跳过）。
- **Provider 选择**：`config.provider || env OVOGO_PROVIDER || 'openai'` → 工厂返回 LLMProvider → Engine.callLLM 委托。
- **MCP 工具注入**：Boot 第3步 modules.boot() 时，McpModule 连接已配置 server → 收集 `tools[]` → 经 `buildToolContext` 合并进 ToolContext；LLM 的 tool_calls 里出现 MCP 工具名 → partition → execute 时路由到 McpCall 工具。
- **Poor 裁剪**：每轮 `onIteration` 若 poor.enabled && cost>阈值 → 置 skipCritic/skipReflection 标志 → Engine 跳过对应 LLM 调用。

## 8. 接口边界

- `LLMProvider`（新接口）：`callStreaming(messages, tools, opts): AsyncIterable<Chunk>`；`name: string`。Engine 依赖此接口，不依赖具体 SDK。
- `AgentModule`（现有，扩展）：Poor/MCP 均实现现有 4 钩子（boot/onIteration/onToolCall/onComplete），不新增钩子。
- `Tool`（现有）：MCP 工具动态包装成现有 `Tool` 形状（definition + execute），复用 partition 调度。
- 配置：新增字段进 `src/config/settings.ts`（provider / poor / mcp.servers[]），保持向后兼容（全可选）。

## 9. 配置体系（新增字段，均可选、默认向后兼容）

```jsonc
{
  "provider": "openai",            // openai(default) | gemini | grok | anthropic
  "poor": { "enabled": false, "tokenBudget": 50000 },
  "mcp": { "servers": [
    { "name": "fs", "type": "stdio", "command": ["npx","-y","@modelcontextprotocol/server-filesystem","."] }
  ]}
}
```
环境变量镜像：`OVOGO_PROVIDER` / `OVOGO_POOR=1` / `OVOGO_MCP_CONFIG=path`。

## 10. 可选功能矩阵

| 功能 | 当前状态 | 默认状态 | 接入方式 | 影响核心 |
|---|---|---|---|---|
| Poor/Budget 模式 | 未实现 | 关闭 | module + config | 否（纯裁剪） |
| Plan Enter/Verify 工具 | 部分(ExitPlan 已有) | 关闭 | tools + planMode | 否 |
| MCP 客户端 | 未实现 | 关闭 | module + config.mcp | 否（动态注入） |
| Gemini Provider | 未实现 | 关闭 | provider 适配 | 否 |
| Grok Provider | 未实现 | 关闭 | provider 适配 | 否 |
| FeatureFlag 系统 | 未实现 | — | 延后，按需 | 否 |

## 11. 向后兼容方案

- 所有新字段默认关闭/缺省回退到现有行为：provider 默认 openai；poor 默认 off；mcp 默认空列表。
- 现有 CLI flags、环境变量、AgentConfig 不变。
- `callLLM` 现有调用点改为经 `LLMProvider` 接口；保留 `OpenAIProvider` 行为与原实现逐字节等价（用现有测试做回归闸门）。
- 不删任何现有工具/模块（原则3）。

## 12. 测试与调试方案

- 单测：每个新模块/工具 ≥1 个 vitest 文件（仿现有 `tests/*.test.ts` 风格）；Provider 用 mock stream。
- 集成：MCP 用本地 stdio echo server（或官方 filesystem server，CI 可选）端到端。
- 回归：`pnpm test` 须保持 941 全绿并只增不减；`pnpm build` 须 0 error。
- 调试：复用 `EventLog`（boot_context/invoke_sent/invoke_completed）记录 provider 选择、poor 跳过、mcp 连接。
- Cost 证据：Poor on/off 各跑同一任务，对比 `costTracker` 输出。

## 13. 风险清单

| 风险 | 等级 | 缓解 |
|---|---|---|
| Provider 抽象改动 callLLM，破坏流式/tool_call 解析 | 高 | 先加接口再迁，保留 OpenAI 行为；用现有 engine/claudeCode/streaming 测试回归 |
| MCP server 不稳定拖垮 Engine | 中 | 连接失败仅警告不阻断 Boot；超时隔离 |
| Gemini/Grok 流格式差异大 | 中 | 先只做"可用"，参照 CCB streamAdapter； Anthropic 原生优先级最低 |
| Poor 模式跳过 critic 导致质量下降 | 低 | 默认关；提供 tokenBudget 阈值；文档说明权衡 |
| 实现委托给 claude 时上下文丢失 | 中 | 每个任务给 claude 精确文件+接口+验收命令；我逐个 review 与回归 |

## 14. 实施顺序（分迭代，每迭代可独立验证）

**Iteration 1（最高价值/最低风险，先做）**
1. **Poor/Budget 模式**（config 字段 + 预算敏感模块自检短路，非专用模块——见 DEVLOG D1）→ cost 对比证据。

**Iteration 2（补全 Plan 闭环）**
2. Plan 工具组：EnterPlanMode / VerifyPlanExecution（对齐 modes.ts + engine.ts:1594 exitPlanMode setter）。

**Iteration 3（"超级"差异点）**
3. MCP 模块（stdio，boot 注入 tools）+ MCP 工具组 → 端到端连一个 server。

**Iteration 4（抽象被实际需求驱动时再做）**
4. 此时抽象 LLMProvider 接口 + 迁移 callLLM(engine.ts:646)/maybeCompact/模块 client，并实现 Gemini/Grok。
5. 若 ≥3 能力需细粒度门控，再抽 FeatureFlag。
6. Daemon / --bg（最低优先，时间不足则砍）。

每步由我（指挥）拆任务 → 委托 `claude -p` 写实现 → 我 review + 跑 `build`/`test` 验证 → 更新 STATE/AUDIT。

## 15. 回滚方案

- 每个迭代在独立逻辑单元；用 git commit 分阶段提交（commit message 遵循 CCB 的 Conventional Commits：feat/fix/refactor）。
- Provider 抽象若破坏回归：保留接口但 `OpenAIProvider` 内联原逻辑，回退 Engine 调用点。
- Poor/MCP/Plan 均为纯增量模块，回滚 = 删除新文件 + 撤销 config 字段，不影响内核。
- 任一迭代导致 941 测试转红且 1 轮内无法修复 → `git revert` 该迭代，记 DEVLOG，重设计。

---

## 附：候选项移植评估（基于已核实参考路径）

| 候选 | CCB 参考 | 价值 | 工作量 | 风险 | 建议优先级 |
|---|---|---|---|---|---|
| Poor/Budget 模式 | `src/commands/poor/{index,poor,poorMode}.ts` | 5（命中 token 痛点） | M | 低 | **P1（Iter1）** |
| LLMProvider 抽象(+Gemini/Grok) | `packages/@ant/model-provider/src/providers/{gemini,grok,openai}` + `src/services/api/{gemini,grok}` | 4 | M(抽象) / L(全 provider) | 中 | **P1（Iter1 抽象）/ P2（provider）** |
| Plan 工具组 | `packages/builtin-tools/src/tools/{EnterPlanMode,ExitPlanMode,VerifyPlanExecution}Tool` | 4 | S | 低 | **P2（Iter2）** |
| MCP 客户端 | `packages/mcp-client/src/{connection,discovery,execution,manager,transport,...}.ts` + `MCPTool/ListMcpResourcesTool/ReadMcpResourceTool` | 5（生态差异点） | L | 中 | **P2（Iter3）** |
| FeatureFlag 系统 | CCB `feature()`（bun:bundle 编译期） | 3 | M | 低 | **P3（延后，按需）** |
| Daemon/--bg 会话 | `src/daemon/{main,workerRegistry}.ts` | 2 | L | 高 | **P4（时间不足则砍）** |

互相依赖：Provider 抽象是 Gemini/Grok 的前置；Poor 与 MCP 互相独立可并行；FeatureFlag 不阻塞任何项（用 config 顶）。
