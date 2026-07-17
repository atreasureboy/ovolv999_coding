# DETAIL_PLAN — 代码层实现方案

> 聚焦 Iteration 1 = Poor/Budget 模式。每个文件改动附验证命令。
> 设计依据见 PLAN.md §5/§9 与 DEVLOG.md D1。实现委托 claude(M3)，我 review + 回归。

## Iteration 1 目标
开启 poor 后，critic 纠错 LLM 调用与 reflection（per-turn 提取 + session 整合）LLM 调用全部跳过；主循环与工具执行不受影响。可由 settings.json 或 `OVOGO_POOR=1` 开启，`/poor` 活体切换并持久化。附带 cost 对比证据。

---

## 改动清单（文件级）

### 1. `src/core/types.ts` — 新增 EngineConfig.poor 字段
- 在 `EngineConfig`（types.ts:217）增加：
  ```ts
  /** Poor/Budget mode — skip non-essential LLM calls (critic, reflection) */
  poor?: { enabled: boolean }
  ```
- 兼容：可选字段，默认 undefined（视为 disabled）。

### 2. `src/config/settings.ts` — 新增 OvogoSettings.poor + 合并
- `OvogoSettings`（settings.ts:78）增加 `poor?: { enabled: boolean }`。
- 在 settings 合并函数（settings.ts:136 附近的 mergeDeep/mergeSettings，按 `taskContext` 合并的同款）增加 poor 合并（project 覆盖 global）。
- 验证：`loadSettings` 合并后返回 `poor` 字段。

### 3. `src/modules/critic.ts` — 预算守卫 + 构造改持 config 引用
- 构造器改为持有 config 引用以支持活体切换：
  ```ts
  constructor(private client: OpenAI, private model: string, private config: { planMode?: boolean; poor?: { enabled: boolean } }) {}
  ```
- `onIteration`（critic.ts:36）首行守卫：`if (this.config.planMode) return` 改读 `this.config.planMode`；新增 `if (this.config.poor?.enabled) return`（紧随其后）。
- 验证：现有 critic 行为不变（planMode 仍跳过）；新增 poor.enabled 跳过。

### 4. `src/modules/reflection.ts` — 预算守卫（两处）
- `ReflectionModule` 构造器同样改为持 config 引用（当前 reflection.ts:45 持 client）；新增 `config` 参数。
- `onComplete`（reflection.ts:54）首行：`if (this.config.poor?.enabled) return`。
- `consolidateSession`（reflection.ts:158，函数式，持 client 参数）增加可选 `poor` 参数：`if (poor?.enabled) return`。
- 验证：poor 关时行为不变；poor 开时两者都不发 LLM。

### 5. `bin/ovogogogo.ts` — 接线
- `bin:1323` CriticModule 注册：`new CriticModule(ctx.client, ctx.model, ctx.config)`（传 config 引用而非 `ctx.config.planMode`）。
- `bin:1326` ReflectionModule 注册：同理传 `ctx.config`。
- `bin:1345` 主 config 构建：增加 `poor: settings.poor ?? (process.env.OVOGO_POOR === '1' ? { enabled: true } : undefined)`。
- `bin:1045` consolidateSession 调用：传入 `config.poor`。
- 验证：`pnpm build` 0 error；`OVOGO_POOR=1` 启动单任务模式可跑通。

### 6. `src/commands/builtin.ts` — 新增 `/poor` 命令
- 仿 `/permissions`（builtin.ts:178）模式，`registerCommand({ name: 'poor', ... })`：
  - 无参：显示当前状态（on/off）。
  - `/poor on` / `/poor off`：写 `saveProjectSettings(cwd, { poor: { enabled } })`，并活体设置当前 engine 的 `config.poor = { enabled }`（同一引用，模块立即可见）。
- 验证：`/poor on` 后 `loadSettings(cwd).poor.enabled === true`。

### 7. Engine 暴露 config（便于 /poor 活体设置）
- 若 engine 未公开 config 引用，确认 `bin` 持有的 `config` 对象与传入 engine 的同一引用（JS 引用语义）。若 ModuleContext.config 是 engine.config 同一对象 → 无需新增 API；否则给 ExecutionEngine 加 `getConfig(): EngineConfig`。**实现时先验证引用一致性，再决定是否加 API。**

---

## 新增测试（tests/，仿现有风格）

### 8. `tests/poorMode.test.ts`（新建）
- T1：CriticModule config.poor.enabled=true → onIteration 不调用 client.create（用 mock client 计数）。
- T2：CriticModule poor 关 → 正常注入（回归现有行为）。
- T3：ReflectionModule poor 开 → onComplete 不调用 client.create。
- T4：consolidateSession(poor={enabled:true}) → 提前 return，不调用 client。
- T5：`/poor on` 命令逻辑 → settings 写入 enabled=true（mock saveProjectSettings 或临时目录）。
- 验证：`pnpm test tests/poorMode.test.ts` 全绿。

### 9. 回归
- 现有 `tests/engine.test.ts`、critic 相关、reflection 相关若直接 `new CriticModule(client, model, planModeBool)` 构造，需改为 `new CriticModule(client, model, { planMode })`。**claude 实现时需 grep 出所有直接构造点并同步改。**
- 验证：`pnpm test` 仍 ≥941 全绿（只增不减）；`pnpm build` 0 error；`pnpm lint` 不新增 error。

---

## 验收命令（实现完成后逐条跑，附证据到 TEST_REPORT.md）
1. `pnpm build` → 0 error
2. `pnpm test` → 全绿，且 `tests/poorMode.test.ts` 出现在结果中
3. `pnpm lint` → 不新增 error
4. 手动 cost 对比（同一任务）：`OVOGO_POOR=1 pnpm dev "<task>"` vs `pnpm dev "<task>"`，对比 EventLog/costTracker 输出的 token/cost，poor 应更低（critic/reflection 调用次数为 0）。

## 风险与回滚
- 构造器签名变更影响直接构造 CriticModule/ReflectionModule 的测试 → claude 须全量改齐，遗漏会导致 tsc 失败（build 即可抓出）。
- 全部为增量 + 可选字段，回滚 = revert 本次提交。

---

# Iteration 2 — Plan 工具组（EnterPlanMode + VerifyPlanExecution）

## 目标
补全 plan 闭环：agent 可经工具**主动进入** plan mode（只读分析），并可在实现后**独立验证**项目构建/lint/test。对齐 CCB 的 EnterPlanModeTool / VerifyPlanExecutionTool。

## 改动清单（文件级）

### 1. `src/core/engine.ts` — 新增 enterPlanMode() setter
- 在 `exitPlanMode()`(engine.ts:1603) 旁对称新增：
  ```ts
  /** Enter plan mode — called by the EnterPlanMode tool */
  enterPlanMode(): void { this.planModeActive = true }
  ```
- 在 `buildToolContext`(engine.ts:1123 exitPlanMode 回调旁) 注入：
  ```ts
  enterPlanMode: () => { this.enterPlanMode() },
  ```

### 2. `src/core/types.ts` — ToolContext 增 enterPlanMode 回调
- `ToolContext`(types.ts:145) 与 `EngineConfig`(types.ts:290) 的 exitPlanMode 旁各加：
  ```ts
  enterPlanMode?: () => void
  ```

### 3. `src/tools/agent.ts` — 导出 runVerification 供复用
- 将 `function runVerification`(agent.ts:105) 改为 `export function runVerification`（不重命名、不改逻辑，仅加 export）。`detectVerifyCommands` 已是 export。

### 4. `src/tools/enterPlanMode.ts`（新建）
- 仿 `src/tools/exitPlanMode.ts` 结构。
- `name='EnterPlanMode'`，`metadata={readOnly:true, concurrencySafe:true}`，`isConcurrencySafe()->true`。
- definition.function.description：说明"进入 plan mode 进行只读分析；分析完用 ExitPlanMode 提交计划待用户批准；不要在需要立即行动时使用"。
- execute(input, ctx)：`ctx.enterPlanMode?.()`；返回 `Entered plan mode. Only read-only tools (Read/Glob/Grep/Web) are available. Analyze, then call ExitPlanMode with your plan for approval.`（input 无必填参数：`parameters:{type:'object',properties:{}}`）。

### 5. `src/tools/verifyPlanExecution.ts`（新建）
- `name='VerifyPlanExecution'`，`metadata={readOnly:false, concurrencySafe:false, longRunning:true}`。
- execute(input, ctx)：`const r = runVerification(ctx.cwd)`；若 `r===null` 返回 `No verification commands detected for this project.`；否则返回 `passed? ✓:✗` + `r.output`（含每条命令 pass/fail + 失败摘要）。`isError` = `!r.passed`（让 LLM 知道验证失败）。
- definition.function.description：说明"运行项目 build/lint/test 验证当前实现；读取 package.json scripts 或按语言回退；用于实现后自检"。

### 6. `src/tools/index.ts` — 注册 + 导出
- createTools() 增加 `new EnterPlanModeTool()`、`new VerifyPlanExecutionTool()`。
- re-export 块增加两个工具类。

### 7. `tests/planTools.test.ts`（新建，仿 tests/exitPlanMode.test.ts）
- T1：EnterPlanModeTool.execute → 调用 `ctx.enterPlanMode` 回调一次，返回包含 "Entered plan mode"。
- T2：EnterPlanMode name/metadata 正确，isConcurrencySafe()===true。
- T3：VerifyPlanExecution 在一个含 package.json{scripts:{build:"..."}} 的 tmp 目录 → 返回 passed 且 isError=false（build 脚本 echo ok）。
- T4：VerifyPlanExecution 在 build 脚本失败的 tmp 目录 → isError=true，content 含 FAILED。
- T5：VerifyPlanExecution 在无识别文件的 tmp 目录 → 返回 "No verification commands detected"。
- T6（engine）：ExecutionEngine.enterPlanMode()/exitPlanMode() 切换 isPlanMode()（若 engine 单测易构造；否则跳过并注明）。

## 关键约束
- EnterPlanMode 是 `readOnly` → 即使在 plan mode 过滤下也可用（语义自洽：可重复进入）。
- VerifyPlanExecution **非 readOnly** → plan mode 下被过滤（验证在实现后，符合语义）。
- runVerification 复用，禁止复制粘贴重复实现。
- 不动 ExitPlanMode 既有行为；不改 LEGACY_PLAN_MODE_TOOLS（ExitPlanMode 仍在）。

## 验收命令
1. `pnpm build` → 0 error
2. `pnpm test` → 全绿（≥952 + 新增 planTools 用例）
3. `pnpm lint` → 0 error
4. 证据贴回 TEST_REPORT.md（Iteration 2 段）

---

# Iteration 3 — MCP 客户端（stdio）+ 工具动态注入

## 目标（"超级"差异点）
ovolv999 可经 `config.mcp.servers` 连接 stdio MCP server，将其工具**动态注入**工具集，LLM 可像内置工具一样调用。最小实现：stdio 传输 + tools 协议（不实现 resources/prompts/sampling/SSE，留扩展点）。**自实现轻量 JSON-RPC 客户端**（保持 3 deps 极简；未来可经接口替换为官方 SDK）。

## MCP 协议要点（实现须严格遵循）
- 传输：子进程 stdin/stdout，**换行分隔的 JSON（每行一条 JSON-RPC 2.0）**。stderr 仅做日志（不入协议）。
- 握手：发 `initialize` 请求 → 收 `result{protocolVersion,capabilities,serverInfo}` → 发 `notifications/initialized` 通知（无 id）。
  - initialize params: `{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"ovolv999",version:"0.1.0"}}`
- 列工具：`tools/list` 请求 → `result{tools:[{name,description,inputSchema}]}`
- 调用：`tools/call` 请求 params `{name,arguments}` → `result{content:[{type:"text",text}],isError?:boolean}`
- JSON-RPC：请求带 `id`（递增整数）；响应按 `id` 匹配；通知无 `id`。每条请求设超时（默认 30s）。

## 改动清单（文件级）

### 1. `src/core/mcpClient.ts`（新建，~250 行）
```ts
export interface McpServerConfig { name: string; type: 'stdio'; command: string[]; env?: Record<string,string>; cwd?: string }
export interface McpToolInfo { name: string; description?: string; inputSchema: unknown }

export class McpStdioClient {
  constructor(server: McpServerConfig)
  async connect(): Promise<void>      // spawn child + initialize 握手 + 发 initialized 通知
  async listTools(): Promise<McpToolInfo[]>
  async callTool(name: string, args: Record<string,unknown>): Promise<{ content: string; isError: boolean }>
  async close(): Promise<void>        // kill child，清理 pending
}
```
- 内部：`spawn(command[0], command.slice(1), {stdio:['pipe','pipe','pipe'], env, cwd})`；按行解析 stdout（`\n` 分割 → JSON.parse）；`id` 计数器 + `Map<id, {resolve,reject,timer}>`；stderr 收集到日志（不混入协议）。
- 请求超时：默认 30s，超时 reject 并标记。
- 错误处理：子进程意外退出 → reject pending；close 幂等。
- 不引入新依赖（用 node:child_process、node:events）。

### 2. `src/tools/mcpToolAdapter.ts`（新建）
- 把单个 MCP tool 包装成 ovolv999 `Tool`：
  - `name = `mcp__${serverName}__${toolName}``（前缀避冲突）
  - `definition.function = { name, description, parameters: inputSchema }`
  - `metadata = { readOnly: false, concurrencySafe: false, requiresNetwork: true }`（保守：MCP 工具副作用未知）
  - `execute(input)` → `client.callTool(toolName, input)` → `{content, isError}`
  - 持有 `McpStdioClient` 引用。

### 3. `src/modules/mcp.ts`（新建，McpModule）
- 实现 `AgentModule`，`readonly name = 'mcp'`，无 dependencies。
- `boot(ctx)`：读 `ctx.config.mcp?.servers ?? []`；对每个 server `new McpStdioClient` → `connect()` → `listTools()` → 每个 tool 包成 `McpToolAdapter`。**连接失败仅 warn 不抛**（一个 server 挂不能阻断 Boot）。
- 返回 `{ tools: allAdapters }`（合并到 `moduleTools`）。
- 模块持有 clients 引用以便后续扩展（v1 不做 onComplete close，进程随 session 退出回收；加注释说明）。

### 4. `src/core/types.ts` — EngineConfig.mcp
```ts
mcp?: { servers: McpServerConfig[] }
```
（McpServerConfig 从 mcpClient.ts 导入，或在此定义并让 mcpClient 导入——择一，避免循环。推荐在 mcpClient.ts 定义并 export，types.ts 用 `import type`。）

### 5. `src/config/settings.ts` — OvogoSettings.mcp + merge
- `mcp?: { servers: McpServerConfig[] }`；normalize 校验 servers 数组每项有 name+command；merge: project 覆盖 global。

### 6. `bin/ovogogogo.ts`
- 注册 `globalModuleRegistry.register('mcp', (ctx) => new McpModule())`。
- 主 config：`mcp: settings.mcp ?? parseOvogoMcpEnv()`（`OVOGO_MCP_CONFIG` 文件路径可选，v1 可只接 settings，env 留 TODO）。
- `enabledModules`：**仅当 `mcp.servers` 非空时**加入 `'mcp'`（空时不开，避免无谓 boot）。

### 7. `tests/fixtures/mcpEchoServer.mjs`（新建，本地确定性 MCP echo server，~50 行）
- Node 脚本：stdin 按行读 JSON-RPC；响应 `initialize`、`tools/list`（返回一个 `echo` 工具，inputSchema `{type:object,properties:{msg:{type:string}}}`）、`tools/call`（返回 `content:[{type:"text",text:"echo: "+args.msg}]`）。其他 method 返回 method-not-found。stderr 打印日志行。

### 8. `tests/mcpClient.test.ts`（新建）
- T1：spawn echoServer fixture → connect() 不抛。
- T2：listTools() 返回 `[{name:'echo',...}]`。
- T3：callTool('echo',{msg:'hi'}) → content 含 "echo: hi"，isError=false。
- T4：close() 后子进程退出（pid 不再存活）。
- T5：请求超时（用一个故意不响应的 server 或注入延迟）→ reject（可选项，若实现复杂则跳过并注明）。
- T6：McpToolAdapter.execute → 调用 client.callTool，name 为 `mcp__<server>__echo`。

## 关键约束
- 零新依赖（仅 node 内置）。
- 连接失败不阻断 Boot（warn + 跳过该 server）。
- MCP 工具默认保守 metadata（非 readOnly）。
- 不实现 resources/prompts/sampling/SSE（v1 范围外，接口预留）。
- fixture server 路径用 `import.meta.url` 解析，保证跨平台。
- 不动 claude-code/ 与 .loop/。

## 验收命令
1. `pnpm build` → 0 error
2. `pnpm test` → 全绿（≥962 + 新增 mcp 用例），exit 0
3. `pnpm lint` → 0 error
4. （可选）端到端：手动配一个 `.ovogo/settings.json` 指向 filesystem server，跑 `pnpm dev` 看 LLM 能看到 `mcp__fs__*` 工具。
5. 证据贴回 TEST_REPORT.md（Iteration 3 段）
