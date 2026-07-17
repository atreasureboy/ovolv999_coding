# TEST_REPORT — 测试命令、结果与结论

## Iteration 1 — Poor/Budget 模式

### 执行命令与结果

| # | 命令 | 结果 | 证据 |
|---|---|---|---|
| 1 | `pnpm build` (tsc) | **0 error**, exit 0 | 类型全通过；含新 `EngineConfig.poor`、`OvogoSettings.poor`、`getConfig()` |
| 2 | `pnpm test` (vitest) | **41 files / 952 tests passed**, exit 0 | 较基线 941 增加 11 个 poor 用例（`tests/poorMode.test.ts`）|
| 3 | `pnpm lint` (eslint) | **0 error**, exit 0 | 无新增 lint 问题 |
| 4 | `node env_check.mjs`（env→config 接线） | OK | `OVOGO_POOR=1 => {enabled:true}`；映射 `bin/ovogogogo.ts:1357` |

### poorMode.test.ts 覆盖（11 用例）
- T1：`CriticModule(poor.enabled=true)` → `onIteration` 不调用 `client.create`（`calls.length===0`）✓
- T2：`CriticModule(poor.enabled=false)` → 仍正常调用（回归，`calls.length>=1`）✓
- 　：`planMode:true` 仍跳过（旧行为不变）✓
- T3：`ReflectionModule(poor.enabled=true)` → `onComplete` 不调用 client，且不写 SemanticMemory ✓
- 　：`poor.enabled=false` → `onComplete` 仍调用（回归）✓
- T4：`consolidateSession(poor={enabled:true})` → 提前 return，`calls===0`、`episodes=0`、`knowledgeExtracted=0` ✓
- 　：`consolidateSession(poor=undefined)` → 正常运行（回归）✓
- T5：`/poor on` → 写 `.ovogo/settings.json` `{poor:{enabled:true}}` **且** 活体设置 `engine.getConfig().poor` ✓
- 　：`/poor off` → 写 `{enabled:false}` 并关闭 ✓
- 　：`/poor`（无参）→ 显示当前 ON/OFF ✓
- 　：`/poor on` 后 settings.json 结构合法（JSON.parse 成功，`raw.poor==={enabled:true}`）✓

### C4（cost 节省）证据说明
- **机制已证**：poor.enabled 时 critic/reflection/consolidate 的 LLM 调用数严格为 0（T1/T3/T4）。critic 每 5 轮一次（CRITIC_INTERVAL=5）、每次最多 400 token（CRITIC_MAX_TOKENS）；reflection 每次 run 一次 + REPL 退出整合一次。
- **推算节省**：一个跑 15 轮的任务，poor 省下 critic 3 次（≈3×400=1200 out token）+ reflection 1~2 次。对长会话显著。
- **未做的 A/B 实跑**：完整 on/off 真实 cost 对比需 ≥5 轮的真实任务（触发 critic），消耗真实 token；优先级低于继续交付 Iter2/3。机制正确性已由单测保证。后续可在真实长任务中补 A/B 数据。

### 结论
Iteration 1 通过。核心路径（单任务/REPL）不受影响（向后兼容，默认 poor 关闭）。无回归（941→952，只增不减）。

---

## Iteration 2 — Plan 工具组（EnterPlanMode + VerifyPlanExecution）

### 执行命令与结果（glm-5.2 独立复验，非仅信 claude 报告）
| # | 命令 | 结果 | 证据 |
|---|---|---|---|
| 1 | `pnpm build` | **0 error**, exit 0 | 新增 enterPlanMode setter/回调、两新工具类、ToolContext/EngineConfig.enterPlanMode |
| 2 | `pnpm test` | **42 files / 962 tests passed**, exit 0 | 较 Iter1 基线 952 增加 10 个 planTools 用例 |
| 3 | `pnpm lint` | **0 error**, exit 0 | 无新增问题（claude 主动避开 require-await：用非 async + Promise.resolve） |

### 实现要点（已 review）
- `engine.ts`：`enterPlanMode()` setter（对称 `exitPlanMode()`）+ `buildToolContext` 注入 `enterPlanMode: () => this.enterPlanMode()`。
- `types.ts`：`ToolContext`@145 与 `EngineConfig`@290 各加 `enterPlanMode?: () => void`。
- `src/tools/agent.ts`：`runVerification` 仅加 `export`（零逻辑改动），供 VerifyPlanExecution 复用 → 零重复实现。
- `enterPlanMode.ts`：readOnly/concurrencySafe；调 `ctx.enterPlanMode?.()`；幂等（重复进入是 no-op）。
- `verifyPlanExecution.ts`：非 readOnly/longRunning（plan mode 下被过滤，符合"实现后验证"语义）；`isError=!passed`。

### planTools.test.ts 覆盖（10 用例）
- T1 EnterPlanMode.execute 调 ctx.enterPlanMode 回调一次 + 返回 "Entered plan mode"
- T2 EnterPlanMode name/metadata/isConcurrencySafe 正确
- T3 VerifyPlanExecution 成功路径（tmp 项目 build 脚本 ok）→ passed, isError=false
- T4 VerifyPlanExecution 失败路径（build 脚本 exit 1）→ isError=true，含 FAILED
- T5 无识别文件 → "No verification commands detected"
- + 异常分支与边界用例

### 委托成本
claude(M3) 实现：$2.1630 / 75 turns（含读文件 + 写 + 跑 build/test/lint）。glm-5.2 复验 build/test/lint 全部一致。

### 结论
Iteration 2 通过。plan 闭环补全：agent 可主动进入只读分析 → 提交计划待批准 → 实现后独立验证。无回归（952→962）。

---

## Iteration 3 — MCP 客户端（stdio）+ 工具动态注入

### 实现说明
**自实现**（委托 claude 写权限被拦，白花 $2.34/57 turns → 按 goal §XV 换策略，glm-5.2 直接落地；见 DEVLOG D3）。最小 stdio MCP 客户端（换行分隔 JSON-RPC 2.0），保持 ovolv999 极简依赖（零新增 runtime dep）。

### 执行命令与结果（glm-5.2 自验）
| # | 命令 | 结果 |
|---|---|---|
| 1 | `pnpm build` | **0 error** |
| 2 | `pnpm test` | **43 files / 974 tests passed**，exit 0（较 Iter2 962 +12 mcp 用例）|
| 3 | `pnpm lint` | **0 error / 0 warning** |

### 新增/改动文件
- 新建 `src/core/mcpClient.ts`（McpStdioClient：connect/listTools/callTool/close；JSON-RPC 分帧 + 超时 + 子进程生命周期）
- 新建 `src/tools/mcpToolAdapter.ts`（MCP tool → ovolv999 Tool，name=`mcp__<server>__<tool>`，保守 metadata）
- 新建 `src/modules/mcp.ts`（McpModule：boot 连接 servers + 注入 tools；**连接失败隔离不阻断**）
- 改 `src/core/types.ts`（EngineConfig.mcp）、`src/config/settings.ts`（OvogoSettings.mcp + normalize + merge）、`bin/ovogogogo.ts`（注册 McpModule + config + 条件 enabledModules）
- 新建 `tests/fixtures/mcpEchoServer.mjs`（本地确定性 MCP echo server）
- 新建 `tests/mcpClient.test.ts`（12 用例：客户端握手/列工具/调用/关闭/超时/adapter/module boot/隔离失败）
- 改 `eslint.config.js`（ignore `tests/fixtures/`）

### 关键设计点
- MCP 协议：initialize 请求 → 响应 → `notifications/initialized` 通知 → tools/list、tools/call。换行分隔 JSON。
- 工具命名空间 `mcp__<server>__<tool>` 避免与内置工具/多 server 冲突。
- 仅 servers 非空时才启用 'mcp' 模块（避免无谓 boot）。
- v1 范围：stdio + tools；resources/prompts/sampling/SSE 未实现（接口预留）。

### 真实 MCP server 端到端冒烟（无 LLM 成本）
配置官方 `@modelcontextprotocol/server-filesystem`（指向 /tmp），McpModule.boot 成功注入：
```
TOOL_COUNT=14
SAMPLE=mcp__fs__read_file, mcp__fs__read_text_file, mcp__fs__read_media_file,
       mcp__fs__read_multiple_files, mcp__fs__write_file, mcp__fs__edit_file
```
→ 真实 server 工具正确注入并命名空间化。

### 结论
Iteration 3 通过。"超级"差异点（MCP 生态接入）落地：零新依赖、连接失败隔离、真实 server 端到端验证。无回归（962→974）。
