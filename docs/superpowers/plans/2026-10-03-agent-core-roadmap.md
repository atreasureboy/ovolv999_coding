# OVO Coding Agent Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐当前 coding agent 的真实执行链、可靠边界、长任务能力和效果验收，形成可维护的统一 harness。

**Architecture:** 沿用现有 Engine、Module、Tool、RunContext、RunStore 和工作区锁。把模型协议、进程策略、事件、审批及扩展注册收敛为明确内部接口；CLI、Ink、无界面和编辑器适配器消费同一运行服务。逐个交付边界替换现有实现，保持兼容入口，不把整个项目迁成竞品架构。

**Tech Stack:** TypeScript strict、ESM、Node >=22.13.0、pnpm@11.25.0、Ink/React、Vitest；原生执行 helper 作为独立可选组件，不替换 TypeScript 主体。

**Spec:** `docs/agent-gap-assessment.md`，基线 `44324598ad01be40b820848651f38d54c17cc2e9`。执行前重新核对代码，已修项不能反向重写。

## Global Constraints

- 保持“超级个人 Coding Agent + 统一 Harness + 可组合模块”定位。
- 沿用 TypeScript strict、ESM、Node `>=22.13.0` 和 pnpm 锁文件。
- 不新增产品中心、评测平台、独立 Agent 产品或重设计 UI，不更换记忆检索算法。
- 不添加代码注释，除非用户明确要求；测试放 `tests/`，镜像 `src/` 职责。
- 保留已有工具/命令的兼容入口，冗余实现通过迁移和弃用收敛。
- 不取消现有工作树保全、验收、产物版本绑定、pending 资源保留、所有权和 revision fencing。
- 未实现/未通过原生验收的平台保持 unsupported；不得静默降级到宿主执行后仍称 isolated。
- 真实模型实验必须显式设置 provider、模型版本、任务数、重复次数和费用/token 上限；离线门禁不需要 API 密钥。
- 共用 Engine/配置/协议的修改由一个集成负责人处理；独立工具/adapter/fixture 可并行，按接口约定合入。
- 每项交付先验证目标失败，再实现和验证；最后独立审查并提交该项。文档现状和计划验收不得写成已通过。

## Review Focus

- 进程在首个轮询前脱离或 PID 被复用：T03/T04 不把未知或不属于本次运行的进程当作已结束/可杀死。
- 崩溃发生在副作用与收据之间：T07 找到确切操作且不自动重复变更。
- 等待审批时输入、配置或工作树改变：T08 使过期批准失效，不授权另一请求。
- 压缩含图文/CJK/用户新纠正的长任务：T10/T11 保留有效要求、来源和必要引用。
- 用户在撤销/重启/插件切换前自行修改文件：T17/T19/T21 保留外部变更和历史数据，不靠覆盖或强制清理通过。

## 交付分组与依赖

这是一份总计划，按独立可验收交付执行；原生隔离按平台拆成 T04-L/T04-W，远程 MCP 和插件不阻塞现有入口修复。

| 分组 | 任务 | 依赖与交付门槛 |
| --- | --- | --- |
| A 基线 | T01 | 首先建立离线闭环和任务结果格式；真实模型分批、限额执行 |
| B 执行 | T02、T03、T04-L、T04-W、T07、T08 | T03 消费 T02；T04 消费 T03；T07/T08 可先用 trusted-local 回归，不能虚报隔离 |
| C 核心 | T05、T06、T09、T10、T13、T14、T16 | T06 消费 T05；T09 消费 T05/T08；T13/T14/T16 的接线修复可先独立完成 |
| D 长任务 | T11、T12、T18、T19、T20 | T12 消费 T03/T07/T09；T19 消费 T07/T09；T20 消费 T03/T08 |
| E 扩展/发布 | T15、T17、T21 | T15 消费 T14/T02；T17 消费 T13–T16；T21 在各交付后增量运行 |

不按行数机械拆文件。Engine 保留协调作用，模型请求、审批、扩展注册、会话交互分别有一个责任明确的服务。双 hooks/plugins/指令 loader 通过适配现有公开调用收敛，旧配置迁移保留备份。

公共类型约定：`OpenAIMessage` 和 `ToolDefinition` 初期沿用当前类型作为兼容输入，provider 原生 reasoning/state 另存不丢失；`EffortLevel` 沿用现有五档；`OutcomeStatus` 沿用当前结果集合。`JsonSchema = Record<string, unknown>`，必须由边界验证，不能仅靠类型断言。下述新接口是设计契约，尚未实现。

---

### T01：形成可重复的 coding task 基线（G24）

**Files:** Create `scripts/agent-eval.mjs`、`scripts/fixtures/coding-tasks/manifest.json`、`tests/core/agentEvaluation.test.ts`; Modify `scripts/release-gate.mjs`、`package.json`、`docs/release-support.md`。

**Interfaces:** Consumes 已有 installed CLI 和 `OutcomeStatus`；Produces `AgentEvalResult {schemaVersion:1, taskId:string, revision:string, model:string, outcome:OutcomeStatus, checksPassed:boolean, unrelatedChanges:string[], durationMs:number, usage:'actual'|'estimated'|'unknown', inputTokens?:number, outputTokens?:number, interventionCount:number}`。固定任务清单与结果存仓库内，不创建平台。

- [ ] 写失败用例：回答“已修复”但未改文件/隐藏测试失败必须 `checksPassed=false`；无关文件修改单列；取消与超限不可记为成功。
- [ ] 运行 `pnpm exec vitest run tests/core/agentEvaluation.test.ts`，确认失败来自尚缺结果校验而非环境。
- [ ] 建立 12 个离线真实临时仓库任务（4 个修 bug、3 个跨文件重构、2 个依赖/构建故障、1 个图文要求、1 个取消恢复、1 个外部文件冲突）；用确定性 provider fixture 驱动实际 read/edit/test 路径。
- [ ] 校验 manifest 必含 base commit、提示、独立验收脚本、允许改动路径、预算。真实模型阶段扩展到 30 个固定任务，每个 3 次，先 3 个任务校准预算；未运行项保留未验收。先记录当前 baseline，不假定后续功能改善效果。
- [ ] 运行 `node scripts/agent-eval.mjs --offline`，12 项结果可追溯且判定符合 fixture；审查并提交。产品对照独立报告模型，OVO 前后比较固定同模型/同预算。

### T02：统一执行策略与凭据环境（G01、G03）

**Files:** Create `src/core/executionPolicy.ts`、`tests/core/executionPolicy.test.ts`; Modify `src/core/executionBackend.ts`、`src/core/types.ts`、`src/config/settings/types.ts`、`src/config/settings/normalization.ts`、`bin/ovogogogo.ts`、`src/modules/mcp.ts`。

**Interfaces:** Produces `ExecutionPolicy {mode:'trusted-local'|'isolated-worker', readableRoots:readonly string[], writableRoots:readonly string[], deniedPaths:readonly string[], network:'deny'|'allowlist'|'unrestricted', allowedHosts:readonly string[], envAllowlist:readonly string[], limits:{processes:number,memoryBytes?:number,cpuMs?:number}}`；`resolveExecutionPolicy(input:unknown,cwd:string):ExecutionPolicy` 和 `buildChildEnvironment(policy:ExecutionPolicy,source:NodeJS.ProcessEnv):NodeJS.ProcessEnv`。Consumes 现有配置优先级与工作区绑定。

- [ ] 写失败用例：保存的 profile/limits 重启后保留；父环境假密钥不进入 Bash/MCP/child/hooks；明确允许的变量及 Windows PATH 大小写正确；越界路径不被规范化成允许路径。
- [ ] 运行 `pnpm exec vitest run tests/core/executionPolicy.test.ts` 确认目标失败。
- [ ] 使所有入口创建同一有效策略；记录来源，默认只传平台运行必需环境，项目所需附加变量由明确配置提供。credentials 由模型 client 持有，不自动转发到仓库命令。
- [ ] 检查未支持的隔离/配额在 spawn 前拒绝，trusted-local 展示其实际边界；执行既有 MCP 配置及 shell 回归。
- [ ] 运行 `pnpm exec vitest run tests/core/executionPolicy.test.ts tests/mcpClient.test.ts tests/settingsLayers.test.ts tests/settingsPermissions.test.ts`；类型检查，审查并提交。

### T03：统一进程归属、取消与物理结算（G02）

**Files:** Create `src/core/managedProcess.ts`、`native/execution-host/Cargo.toml`、`native/execution-host/src/main.rs`、`tests/core/processOwnership.test.ts`、`tests/fixtures/process-ownership.mjs`; Modify `src/core/executionBackend.ts`、`src/core/processTree.ts`、`src/tools/bash.ts`、`src/core/mcpClient.ts`、`src/core/backgroundTaskManager.ts`。

**Interfaces:** Consumes T02 `ExecutionPolicy`；Produces `ManagedProcess {id:string, accounting:'contained'|'observed-only', stdin:NodeJS.WritableStream|null, exited:Promise<{exitCode:number|null}>, physicallySettled:Promise<void>, stop(reason:string):Promise<void>}`，`spawnManagedProcess(executable:string,args:readonly string[],options:{cwd:string,env:NodeJS.ProcessEnv,policy:ExecutionPolicy,signal?:AbortSignal}):Promise<ManagedProcess>`。资源锁只在 physicallySettled 后释放。

- [ ] 写真实失败 fixture：快速父退出/后代脱离、忽略 TERM、持有输出句柄、PID 复用、取消期间新后代；同 fixture 覆盖前台、后台、managed exec 与 MCP。
- [ ] 运行 `pnpm exec vitest run tests/core/processOwnership.test.ts`，保留失败证据，不修改为只检查“报告完成”。
- [ ] 统一所有执行路径。最小 Windows helper 先挂起创建、加入 Job Object 后恢复，取消关闭所属 job；此阶段 Linux trusted-local 沿用身份核对和 observed-only，T04-L 再增加 PID namespace 包含。没有包含能力时不升级保证，未知资源保持隔离。
- [ ] 容量以仍占用的物理资源结算；重启/取消保留 identity 和资源 ID；不能靠更频繁轮询提升保证级别。
- [ ] 运行新 fixture 及 `tests/core/backgroundTaskOrphan.test.ts`、现有 Bash/MCP 退出测试；核对真实存活进程并审查提交。

### T04-L：Linux 隔离执行（G01）

**Files:** Create `src/core/execution/linux.ts`、`tests/core/linuxIsolation.test.ts`、`scripts/fixtures/isolation-probe.mjs`; Modify `src/core/executionBackend.ts`、`scripts/package-smoke.mjs`、`docs/release-support.md`。

**Interfaces:** Consumes T02/T03；Produces `probeIsolationCapabilities():Promise<{filesystem:boolean,network:boolean,processTree:boolean,limits:readonly string[],reason?:string}>` 和 `spawnIsolatedProcess(executable:string,args:readonly string[],options:{cwd:string,env:NodeJS.ProcessEnv,policy:ExecutionPolicy,signal?:AbortSignal}):Promise<ManagedProcess>`，仅在声明的能力全通过时激活。

- [ ] 写失败 fixture：外部写、deny-path 读、符号链接越界、直连出网、代理白名单绕过、脱离进程、不可用 user namespace。
- [ ] 在 Linux CI 运行 `pnpm exec vitest run tests/core/linuxIsolation.test.ts` 并记录真实失败。
- [ ] 用 bubblewrap 的文件系统/PID 边界、受控网络代理及明确可用的资源控制实现 adapter；不申请不到配额却声称已限制。探测结果缓存到实际平台/依赖版本，启动异常 fail closed。
- [ ] 从安装包运行 probe，允许项目内构建，拒绝 fixture 越界；缺依赖仍在执行前拒绝。
- [ ] 发布 Linux 独立资格证据，审查并提交；不据 Linux 通过升级 Windows 状态。

### T04-W：Windows 隔离执行（G01）

**Files:** Create `src/core/execution/windows.ts`、`tests/core/windowsIsolation.test.ts`; Modify `native/execution-host/Cargo.toml`、`native/execution-host/src/main.rs`、`scripts/build.mjs`、`scripts/package-smoke.mjs`、`docs/release-support.md`。

**Interfaces:** 与 T04-L 同能力/启动契约；helper 使用版本化 JSONL 控制消息，工人命令和凭据不经过 shell 拼接；Consumes T03 的 Job Object 所有权。

- [ ] 写真实 probe：目录 ACL/受限令牌越界、junction/reparse point、外部可执行文件启动、网络直连、Job 逃逸、长路径/Unicode、helper 缺失/版本不符。
- [ ] 运行 `pnpm exec vitest run tests/core/windowsIsolation.test.ts`，保留未实现导致的失败。
- [ ] 先验证受限令牌/目录权限与网络代理的最小原型；只有全部边界可证明才接到 isolated-worker。若原型不能阻止直连/越界，保留 unsupported 并修改平台能力说明，不用兼容启动冒充隔离。
- [ ] helper 二进制按目标平台构建、校验版本/摘要；最小权限启动与 Job 绑定先于工人执行，禁止 fallback 到普通 spawn。
- [ ] 用干净安装包执行 probe 和普通 Node/Git/构建任务；审查原生边界并独立提交。

### T05：Provider adapter、能力与有效 effort（G06、G07）

**Files:** Create `src/core/model/types.ts`、`src/core/model/chatCompletions.ts`、`src/core/model/responses.ts`、`src/core/model/anthropic.ts`、`tests/core/modelAdapters.test.ts`; Modify `src/core/modelGateway.ts`、`src/core/engine.ts`、`src/core/providers.ts`、`src/core/effort.ts`、`src/commands/configurationCommands.ts`、`src/core/types.ts`。

**Interfaces:** Produces `ModelCapabilities {tools:boolean,vision:boolean,reasoning:boolean,structuredOutput:boolean,contextWindow:number,maxOutputTokens:number}`；`ModelRequest {model:string,messages:readonly OpenAIMessage[],tools:readonly ToolDefinition[],effort:EffortLevel,maxOutputTokens:number,responseSchema?:JsonSchema}`；`ModelAdapter.stream(request:ModelRequest,signal:AbortSignal):AsyncIterable<ModelEvent>`。provider 原生续接 state 由 adapter 持有并持久化，不能折成普通文本丢掉。`NormalizedUsage` 与 event 结构如下，state 是经 adapter 验证的 opaque 值，不能在别的 provider 重用：

```typescript
type NormalizedUsage = {
  kind: 'actual' | 'estimated' | 'unknown'
  inputTokens?: number
  cachedInputTokens?: number
  cacheWriteTokens?: number
  outputTokens?: number
  reasoningTokens?: number
}
type ModelEvent =
  | { type: 'textDelta'; text: string }
  | { type: 'toolCallDelta'; callId: string; name?: string; argumentsDelta: string }
  | { type: 'reasoningDelta'; text: string; providerState?: unknown }
  | { type: 'usage'; usage: NormalizedUsage }
  | { type: 'completed'; providerState?: unknown }
  | { type: 'failed'; code: string; message: string; retryable: boolean }
```

- [ ] 先写失败测试：`/effort high` 改变下一实际请求参数；配置原生 Anthropic 不能发 chat/completions；unsupported 能力在请求前诊断；子代理继承 effort。
- [ ] 运行 `pnpm exec vitest run tests/core/modelAdapters.test.ts` 确认目标失败。
- [ ] 先抽现有 Chat adapter 保持行为，再实现 Responses/Messages 的文本、图片、工具、原生 reasoning/state、用量和错误映射。能力来源统一，保留用户模型 override；不凭前缀硬推 unsupported 参数。
- [ ] 所有主请求、摘要、critic/reflection/图像工具共用 gateway 的限额、取消、超时和重试；请求能力不支持时明确拒绝/解释支持的回退。
- [ ] 跑 adapter fixture、`tests/productionGateway.test.ts`、effort 测试与类型检查；原生账号验收另记，审查提交。

### T06：完整 run-family 用量与费用（G08）

**Files:** Create `src/core/usageLedger.ts`、`tests/core/usageLedger.test.ts`; Modify `src/core/modelGateway.ts`、`src/core/costTracker.ts`、`src/core/providers/registry.ts`、`src/utils/cacheStats.ts`、`src/ui/ink/replController.ts`、`bin/ovogogogo.ts`。

**Interfaces:** Consumes T05 `NormalizedUsage`；Produces `UsageRecord = NormalizedUsage & {requestId:string,runId:string,familyId:string,model:string,costUSD?:number}`；`UsageSummary {requestCount:number,actualRequestCount:number,estimatedRequestCount:number,unknownRequestCount:number,inputTokens:number,cachedInputTokens:number,cacheWriteTokens:number,outputTokens:number,reasoningTokens:number,knownCostUSD:number,unknownPriceRequestCount:number}`；`recordUsage(record:UsageRecord):void`、`summarizeUsage(familyId:string):UsageSummary`。未知计数单列，数值合计只包含有证据的类别，不能解释为全部实际用量。

- [ ] 写失败测试：parent+compact+critic+reflection+child 共 5 次用量全部汇总；重复 usage 不双算；取消未知用量保留；缓存价格不按全价输入；reasoning 是 output 子集的 provider 不重复收费；重启合计不丢。
- [ ] 运行 `pnpm exec vitest run tests/core/usageLedger.test.ts` 确認目标失败。
- [ ] 以 requestId 去重 gateway 结算；UI/命令/cache-stats 消费同一 ledger，价格目录统一并记录版本/override。保留现有 admission 预留/实际结算算法。
- [ ] 验证 parent 与 child 单独视图和 family 汇总一致；未知价格明确显示未知，不能显示“免费”。
- [ ] 跑用量、costTracker、productionGateway 测试与类型检查，审查提交。

### T07：操作恢复与工作树对账（G04、G28）

**Files:** Create `src/core/operationRecovery.ts`、`src/core/worktreeStore.ts`、`tests/core/operationRecovery.test.ts`、`tests/core/worktreeRecovery.test.ts`; Modify `src/core/runStore.ts`、`src/core/runtimeRecovery.ts`、`src/core/engine.ts`、`src/tools/worktree.ts`。

**Interfaces:** Produces `OperationIntent {operationId:string,tool:string,inputDigest:string,workspace:string,resourceIds:string[],affectedPaths:string[],beforeArtifact?:string,idempotencyKey?:string}`；`reconcileOperation(id:string,decision:'keep'|'cancel'|'continue'):Promise<{status:OutcomeStatus,receiptId:string}>`。工作树存储有 owner/epoch/revision，验收 evidence 绑定 definitionHash/artifactVersion/targetCommit。

- [ ] 写失败测试：写入前/后/收据前/创建工人后强制退出；重启指出确切操作，不能重复外部副作用；metadata 写入故障仍列出实际树；目标变化使旧验收失效。
- [ ] 运行 `pnpm exec vitest run tests/core/operationRecovery.test.ts tests/core/worktreeRecovery.test.ts` 验证目标失败。
- [ ] 保存摘要、资源与产物引用，不将明文密钥落盘；内建文件工具可比对 hash 结算，外部副作用无幂等证据时保持待协调。允许 read-only 重跑，mutation 需明确 reconciliation。
- [ ] 工作树元数据 durable write 与 revision fencing；对账 `git worktree list --porcelain`，未知树只报告、不得自动删除；持久验收重启时重新检查现有产物/目标。
- [ ] 跑恢复及现有 worktree acceptance/ownership 测试，检查未提交内容仍保留；审查提交。

### T08：统一审批宿主、队列和作用域（G05）

**Files:** Create `src/core/approvalBroker.ts`、`src/cli/approvalHost.ts`、`tests/core/approvalBroker.test.ts`; Modify `src/core/permissionSystem.ts`、`src/core/riskClassifier.ts`、`bin/ovogogogo.ts`、`src/ui/ink/store.ts`、`src/ui/ink/components/PermissionDialog.tsx`。

**Interfaces:** Produces `ApprovalRequest {requestId:string,runId:string,operationId:string,inputDigest:string,cwd:string,tool:string,preview:string,signal:AbortSignal}`；`ApprovalDecision {requestId:string,inputDigest:string,action:'allow'|'deny',scope:'once'|'session'|'rule',rule?:string}`；`ApprovalBroker.request(request:ApprovalRequest):Promise<ApprovalDecision>`，普通 TTY、Ink 和远程客户端实现同一 host。

- [ ] 写失败测试：3 个并发 ask 全部排队且各决策一次；预览长尾可查看；改输入/cwd 后旧批准无效；批准 npm test 不放行删除/push；取消/断开宿主不伪造同意。
- [ ] 运行 `pnpm exec vitest run tests/core/approvalBroker.test.ts` 确认目标失败。
- [ ] 统一审批入口和等待状态；已有规则持久化兼容迁移，Always 改为明确范围选择；非交互没有 host 时返回结构化 needs_input，保留待办供继续。
- [ ] 加 Bash/cmd/PowerShell 风险语料，未知/无法解析命令在谨慎模式要求审批；风险分类不提供内核保证。
- [ ] 跑权限、Ink overlay、CLI 回归，验证一次批准只执行一次目标操作；审查提交。

### T09：运行事件、无界面和客户端入口（G13、G14）

**Files:** Create `src/core/agentService.ts`、`src/core/agentEvents.ts`、`src/core/agentEventStore.ts`、`src/cli/exec.ts`、`tests/integrations/agentService.test.ts`、`tests/cli/exec.test.ts`; Modify `src/core/engine.ts`、`src/core/eventLog.ts`、`src/cli/args.ts`、`bin/ovogogogo.ts`、`src/integrations/acp.ts`、`src/integrations/acp/protocol.ts`。

**Interfaces:** Produces `AgentService.start(input:{threadId?:string,cwd:string,text:string,responseSchema?:JsonSchema}):Promise<{threadId:string,turnId:string}>`、`steer(threadId:string,expectedTurnId:string,text:string):Promise<void>`、`interrupt(threadId:string,turnId:string):Promise<void>`、`subscribe(threadId:string,afterSequence:number):AsyncIterable<AgentEvent>`。eventStore 持久顺序号，过期游标明确返回 `cursor_expired` 并给出 snapshot 获取路径，不静默跳过。事件结构为：

```typescript
type AgentEvent = { schemaVersion: 1; sequence: number; threadId: string; turnId: string } & (
  | { type: 'turn.started' }
  | { type: 'item.started'; itemId: string; kind: 'message' | 'tool' | 'verification' }
  | { type: 'item.delta'; itemId: string; text: string }
  | { type: 'item.completed'; itemId: string; result: ToolResult | string }
  | { type: 'turn.finished'; status: OutcomeStatus }
  | { type: 'approval.requested'; request: Omit<ApprovalRequest, 'signal'> }
  | { type: 'error'; code: string; message: string }
)
```

- [ ] 写失败测试：已安装 CLI 读→改→测产生同一 run 的可解析 JSONL；最终状态与退出码相符；schema 无效先拒绝；stale steer 拒绝；重连游标无丢失/无重复；断开审批 host 保留待办。
- [ ] 运行 `pnpm exec vitest run tests/integrations/agentService.test.ts tests/cli/exec.test.ts` 确认目标失败。
- [ ] service 统一 turn/history/approval 状态；事件有稳定顺序和 terminal item，不以 best-effort audit log 代替持久会话事件。UI 成为订阅者，不持有另一套 engine 流程。
- [ ] 新增 `exec --jsonl --output-schema <file>`，保持旧 `--pipe` 为明确的只回答兼容入口；ACP adapter 由实际 service 驱动，声明支持的方法/版本，不冒充未验收的标准兼容。
- [ ] 用一个真实客户端完成会话、流式、审批、取消、续接；跑安装包 smoke 与既有 outcome/取消测试，审查提交。

### T10：多模态压缩和容量校准（G09、G10）

**Files:** Create `tests/core/contextFidelity.test.ts`、`scripts/fixtures/context-corpus.json`; Modify `src/core/compact.ts`、`src/core/compact/tokens.ts`、`src/core/compact/budget.ts`、`src/core/snipCompact.ts`、`src/core/modelGateway.ts`。

**Interfaces:** Consumes T05 能力/usage；Produces `serializeCompactionInput(messages:readonly OpenAIMessage[]):string` 与 `estimateModelInput(model:string,messages:readonly OpenAIMessage[],tools:readonly ToolDefinition[]):{tokens:number,method:'counted'|'calibrated'|'conservative',margin:number}`。attachments 用可访问引用+说明，不能把 base64 全部写入摘要或丢掉附带文字。

- [ ] 写失败测试：旧图文数组的文字约束保留；超过 200 字符的工具参数保留关键路径/目的；多次压缩仍留用户纠正、验收要求、未完成任务与准确工具配对。
- [ ] 运行 `pnpm exec vitest run tests/core/contextFidelity.test.ts` 确认目标失败。
- [ ] 修复串行化，保持原始历史可引用；摘要结果和结构化任务状态分开存。保留现有取消、近期窗口与边界修复逻辑。
- [ ] 用 English/CJK/code/schema/image 的固定语料对实际 provider 计数/usage 校准；支持精确计数时采用，其他记录保守误差边界。近窗口 fixture 验证不会无休止压缩重试。
- [ ] 跑 context corpus、compact 与 compactionCancellation 测试；真实 provider 计数未执行时标未验收，审查提交。

### T11：记忆更正的来源和有效状态（G26）

**Files:** Create `tests/core/memorySupersession.test.ts`; Modify `src/core/semanticMemory.ts`、`src/modules/memory.ts`、`src/modules/reflection.ts`、`src/memory/index.ts`。

**Interfaces:** Produces 显式 `supersedes?:string[]`、`state:'active'|'superseded'` 和 `sourceRef?:{sessionId:string,turnId:string,role:'user'|'assistant'}`；`supersedeMemory(oldIds:readonly string[],replacementId:string):void`。Consumes 现有词法检索，默认不自动用相似度判定矛盾。

- [x] 写失败测试：用户明确更正旧约定后，只注入新 active 约定；旧条目仍可审计；双语改写不自动撤销无关事实；导入旧数据可用。
- [x] 运行 `pnpm exec vitest run tests/core/memorySupersession.test.ts` 确认目标失败。
- [x] 只增加来源、显式替代和活动过滤，不引入向量数据库/新排序算法。自动抽取的意见不能覆盖用户规则。
- [x] 验证重启与并发持久写入保留所有权/版本边界。
- [x] 跑记忆相关测试，审查提交。

2026-10-04 交付：原始 18 项 RED、两轮独立问题修复、181 项记忆回归和最终 4414 项整仓通过；来源仍是不认证身份的归属声明。详见 `docs/agent-core-progress.md`，临时审查证据保留在被忽略的 `.artifacts/agent-core/reports/`。

### T12：工作区并发与原生子代理续接（G11、G12）

**Files:** Create `src/core/agentRegistry.ts`、`tests/tools/agentContinuation.test.ts`、`tests/core/agentWorkspaceConcurrency.test.ts`; Modify `src/tools/agent.ts`、`src/core/engine/toolPolicy.ts`、`src/core/engine.ts`、`src/core/messageBus.ts`。

**Interfaces:** Consumes T03/T07/T09；Produces `AgentHandle {agentId:string,threadId:string,workspace:WorkspaceBinding,status:'running'|OutcomeStatus}`；`AgentRegistry.start(input:{prompt:string,agentType:string,workspace:WorkspaceBinding,parentRunId:string,model?:string,effort?:EffortLevel}):Promise<AgentHandle>`、`send(agentId:string,text:string):Promise<void>`、`stop(agentId:string):Promise<void>`、`resume(agentId:string):Promise<AgentHandle>`。agentType 按现有 preset 校验；sessionDir 为独立孩子目录，继承预算/权限/effort，不能扩大权限。

- [ ] 写失败测试：不同工作树两个 child 同时到达 barrier；同工作区串行；续接知道先前发现；取消一个不取消另一个；进程重启后孩子 transcript 可恢复。
- [ ] 运行 `pnpm exec vitest run tests/tools/agentContinuation.test.ts tests/core/agentWorkspaceConcurrency.test.ts` 确认目标失败。
- [ ] 调度判定使用 workspace identity 和资源冲突，而非把 Agent 全局标 safe；保留原队列、隔离锁、父子准入、深度限制与验收证据。
- [ ] follow-up 经 service/message bus 接入，结束保留可续接身份；部分结果仍标部分，不能靠文本 DONE 结算。
- [ ] 跑 Agent acceptance/cancellation/worktree 回归与 family usage 测试，审查提交。

### T13：统一技能调用、界面语义和路径规则（G17、G18、G22）

**Files:** Create `src/core/instructionResolver.ts`、`src/skills/runtime.ts`、`tests/skills/runtime.test.ts`、`tests/core/instructionResolver.test.ts`; Modify `src/skills/loader.ts`、`src/tools/loadSkill.ts`、`src/config/ovogomd.ts`、`src/core/systemPrompt.ts`、`src/cli/repl.ts`、`src/ui/ink/replController.ts`、`src/ui/ink/App.tsx`。

**Interfaces:** Produces `SkillInvocation {name:string,args:string,prompt:string,sourcePath:string,eligible:boolean,requiredTools:readonly string[],restrictedTools?:readonly string[],diagnostics:readonly string[]}`、`resolveSkillInvocation(name:string,args:string,origin:'user'|'model'):SkillInvocation` 和 `resolveInstructions(cwd:string,targetPaths:readonly string[]):Promise<readonly {path:string,scope:string,content:string,digest:string}[]>`。required-tools、permission grant、tool restriction 三种语义分别命名，不混用。

- [ ] 写失败测试：同 `/skill args` 在 CLI/Ink 得到完全相同展开/来源；用户专用技能模型不可触发；未知元数据有诊断；兄弟子树不串规则；文件变更后下一规定边界刷新。
- [ ] 运行 `pnpm exec vitest run tests/skills/runtime.test.ts tests/core/instructionResolver.test.ts` 确认目标失败。
- [ ] 两个 UI 消费共同 runtime，普通 `load_skill` 保留按需内容加载；复杂 fork/model/hooks 先明确 unsupported，不默默丢字段。
- [ ] 收敛指令 loader，明确 OVOGO/AGENTS/CLAUDE 兼容顺序与容量；路径跨子树操作加载适用规则和来源，同轮多个路径冲突则明确报告。保留启动 root→cwd 指令链。
- [ ] 跑 loader/commands/Ink 回归，验证只有适用规则进入请求；审查提交。

### T14：接通 MCP 资源注册表（G16）

**Files:** Modify `src/core/types.ts`、`src/modules/mcp.ts`、`src/tools/mcpResources.ts`; Create `tests/modules/mcpResourcesIntegration.test.ts`。

**Interfaces:** Produces 正式 `ToolContext.mcpRegistry:ReadonlyMap<string,McpRegistryEntry>`，通过已存在 module `toolContextPatch` 注入；entry 提供现有 list/read/prompts 方法及取消信号。Consumes 当前 stdio client，不依赖 T15。

- [x] 写失败集成：配置一个真实 fixture server，同一个 engine turn 调 tool、list resource、read resource；不允许测试手工注入 registry。
- [x] 运行目标测试确认真实接线失败；Windows 本地 pnpm exec shim 无法启动，使用现有 Node Vitest 入口，无依赖变更。
- [x] 将已连接 clients 注入 context；断开/重配时删旧 entry，去掉未声明类型的双断言。
- [x] 验证服务关闭、重复名称、读超限、取消和服务器错误仍走现有边界。
- [x] 跑 MCP lifecycle/discovery 测试与类型检查、完整 264 文件测试，并完成独立审查；交付记录见 `docs/agent-core-progress.md`。

### T15：MCP 协商、分页、通知与远程服务（G15）

**Files:** Create `src/core/mcp/httpTransport.ts`、`tests/core/mcpProtocolCompatibility.test.ts`; Modify `src/core/mcpClient.ts`、`src/config/settings/types.ts`、`src/config/settings/normalization.ts`、`src/modules/mcp.ts`。

**Interfaces:** Consumes T02/T14；Produces `McpTransport {request(method:string,params:unknown,signal?:AbortSignal):Promise<unknown>,notifications:AsyncIterable<unknown>,close():Promise<void>}`，客户端方法保留兼容签名，配置支持 `stdio` 与明确的 Streamable HTTP。

- [ ] 写失败测试：多页 tools/resources/prompts 全部可见；受支持版本协商；list_changed 更新；服务端请求通过审批 host；HTTP token 过期/重连/取消可结算。
- [ ] 运行 `pnpm exec vitest run tests/core/mcpProtocolCompatibility.test.ts` 确认目标失败。
- [ ] 先抽 stdio transport 并保持容量/退出保证，再加 HTTP 与认证状态；未知服务端请求明确不支持，不静默忽略。
- [ ] 工具定义使用按需 catalog/search，能力不支持时有有界 upfront 回退；凭据按域持有，不进入普通子进程或日志。
- [ ] 真实本地和认证 HTTP fixture 从安装包验收，在线服务单独资格记录；审查提交。

### T16：统一 Hooks 配置和执行（G03、G18、G19）

**Files:** Create `src/core/hookService.ts`、`tests/core/hookService.test.ts`; Modify `src/core/hooks.ts`、`src/config/hooks.ts`、`src/config/settings/types.ts`、`src/commands/integrationsCommands.ts`、`src/core/engine.ts`、`src/cli/repl.ts`、`src/ui/ink/replController.ts`。

**Interfaces:** Consumes T02/T03/T08；Produces `HookDecision {action:'continue'|'deny'|'ask',reason?:string,updatedInput?:Record<string,unknown>}`、`NormalizedHookEntry {id:string,event:HookEvent,matcher?:string,command:readonly string[],kind:'notification'|'policy'}`；`beforeTool(operation:ApprovalRequest,input:Record<string,unknown>):Promise<HookDecision>` 与 `notify(event:HookEvent):Promise<void>`。HookEvent 沿用 `src/core/hooks.ts` 的事件并增加兼容映射，不保留另一套同名类型；通知 hooks 可 best-effort，用户声明的 policy hook deny/error 不能作为通知忽略。

- [ ] 写失败测试：`/hooks` 添加、重启、实际 Write 被 deny 且零副作用；post hook 一次；CLI/Ink prompt hook 一致；假密钥不可见；hook 修改输入后重新权限检查。
- [ ] 运行 `pnpm exec vitest run tests/core/hookService.test.ts` 确认目标失败。
- [ ] 迁移双配置为一个来源可追溯的 service，旧文件保留备份，冲突明确诊断；用 managed async runner 避免阻塞 UI/绕过资源策略。
- [ ] 引擎消费 policy decision；定义 deny 优先、deadline/取消、修改输入 digest 和重新审批；通知失败保留原有可观测降级语义。
- [ ] 跑 hooks/permissions/UI 回归，检查实际调用记录，审查提交。

### T17：插件组件加载与撤销（G20）

**Files:** Create `src/core/pluginRuntime.ts`、`tests/core/pluginRuntime.test.ts`、`tests/fixtures/runtime-plugin/`; Modify `src/core/pluginManager.ts`、`src/core/plugins.ts`、`src/commands/integrationsCommands.ts`、`bin/ovogogogo.ts`。

**Interfaces:** Consumes T13–T16；Produces `PluginContribution {pluginId:string,version:string,tools:readonly Tool[],skills:readonly Skill[],commands:readonly Command[],mcp:readonly McpServerConfig[],hooks:readonly NormalizedHookEntry[]}`；`loadPlugin(id:string):Promise<PluginContribution>`、`unloadPlugin(id:string):Promise<void>`。原 manifest 外部入口适配到同一 schema。

- [ ] 写失败测试：本地插件包含 tool/command/skill/hook/MCP，启用+重启全部实际可用；禁用全部撤销；组件加载中断不遗留半启用状态；用户编辑文件不被覆盖。
- [ ] 运行 `pnpm exec vitest run tests/core/pluginRuntime.test.ts` 确认目标失败。
- [ ] 合并双 manager 的持久/校验模型，Enabled 仅在组件装配成功后成立；失败显示来源和状态，禁止借用 require/import 未审查任意路径。
- [ ] 本阶段只资格化已有本地安装；npm/Git 分发保留 unsupported，不创建市场。撤销等所属进程物理结束再移除能力。
- [ ] 跑插件/扩展端到端与干净包测试，审查提交。

### T18：真实语言服务接入编码循环（G21）

**Files:** Create `src/core/languageService.ts`、`src/tools/codeNavigation.ts`、`tests/integrations/languageService.test.ts`; Modify `src/core/lspClient.ts`、`src/tools/fileOperations.ts`、`src/tools/index.ts`、`src/commands/integrationsCommands.ts`。

**Interfaces:** Produces `CodeLocation {uri:string,range:LspRange}`，复用现有 `LspRange`/`LspDiagnostic`；`LanguageService.open(path:string):Promise<void>`、`changed(path:string,version:number):Promise<void>`、`definition(path:string,line:number,column:number):Promise<CodeLocation[]>`、`references(path:string,line:number,column:number):Promise<CodeLocation[]>`、`diagnostics(path:string):Promise<LspDiagnostic[]>`。Consumes T03 管理进程；API 使用 LSP 零基坐标，工具的显示坐标仅在边界转换一次。

- [ ] 写真实 TypeScript fixture：definition/reference 命中正确路径行号；通过 OVO 改错出现诊断、修复后清除；取消请求和关闭服务物理结算。
- [ ] 用固定版本 TypeScript language server 在 Windows/Linux 运行 `pnpm exec vitest run tests/integrations/languageService.test.ts`，确认当前接线失败；此套不替代现有 mock 边界测试。
- [ ] file mutation 后送 didChange，给模型有界诊断摘要和可调用导航工具；不可用服务明确降级到已有搜索，不能伪造“无错误”。
- [ ] 只选 TypeScript 作为首个资格目标，Python 等逐个加入；服务安装版本锁定并记录来源。
- [ ] 跑真实服务、framing 和取消测试，审查提交。

### T19：回合检查点与安全 rewind（G23）

**Files:** Create `src/core/turnCheckpoint.ts`、`tests/core/turnCheckpoint.test.ts`; Modify `src/core/fileHistory.ts`、`src/core/sessionManager.ts`、`src/tools/fileOperations.ts`、`src/commands/workspaceCommands.ts`、`src/core/agentService.ts`。

**Interfaces:** Consumes T07/T09；Produces `TurnCheckpoint {checkpointId:string,threadId:string,turnId:string,messageBoundary:number,files:readonly {path:string,versionId:string,beforeHash:string|null,afterHash:string|null}[]}`；`restoreCheckpoint(id:string,mode:'code'|'conversation'|'both'):Promise<{restored:string[],conflicts:string[],unsupported:string[]}>`。

- [ ] 写失败测试：3 回合修改多个已有/新文件，分别 code/conversation/both 恢复第 2 回合；重启同结果；用户外部改动冲突保留；symlink/hardlink、缺快照和 shell 改动明确 unsupported。
- [ ] 运行 `pnpm exec vitest run tests/core/turnCheckpoint.test.ts` 确认目标失败。
- [ ] 建立 turn→文件版本关系和有界保留；恢复先预检目标 hash、暂存原状态、持久 intent，再更新会话；中断由 T07 可协调，不伪称多文件文件系统原子事务。
- [ ] `/undo` 保持兼容基线含义；`/rewind` 新增选择回合和模式。不会回滚远程系统、未跟踪 shell 操作或他人文件。
- [ ] 跑 fileHistory/session ownership/mutation failure 测试，审查提交。

### T20：可取消的交互式终端会话（G27）

**Files:** Create `src/core/terminalSession.ts`、`src/tools/terminalSession.ts`、`tests/tools/terminalSession.test.ts`; Modify `src/core/backgroundTaskManager.ts`、`src/tools/tmuxSession.ts`、`src/tools/shellSession.ts`、`src/tools/index.ts`、`scripts/package-smoke.mjs`。

**Interfaces:** Consumes T03/T08；Produces `TerminalSession {sessionId:string,runId:string,accounting:'contained'|'observed-only'}`；`startTerminal(input:{executable:string,args:readonly string[],cwd:string,runId:string,columns:number,rows:number}):Promise<TerminalSession>`、`writeTerminal(sessionId:string,input:string,options?:{sensitive:boolean}):Promise<void>`、`readTerminal(sessionId:string,cursor:number):Promise<{text:string,nextCursor:number,exited:boolean}>`、`resizeTerminal(sessionId:string,columns:number,rows:number):Promise<void>`、`stopTerminal(sessionId:string):Promise<void>`。先适配现有 TmuxSession/ShellSession，保留它们的兼容入口，不能重复创建一套无关交互系统。

- [ ] 写真实 fixture：命令等待 stdin，继续输入完成；输出有界且游标正确；terminal resize/Unicode；取消/失联所属资源结束；另一个 run 无权写入；密钥输入不落普通日志。
- [ ] 运行 `pnpm exec vitest run tests/tools/terminalSession.test.ts` 确认目标失败。
- [ ] 实现适配受支持平台的 PTY/ConPTY，保留现有普通 Bash 快速路径；新会话继承执行策略和审批，不把任意 stdin 当自动允许行为。
- [ ] 密钥或外部认证需要用户渠道，避免模型要求输出凭据；平台未资格化则拒绝 session 模式。
- [ ] 安装包跑真实输入/输出/取消测试，审查提交。

### T21：资格矩阵、收敛和最终交付（G25）

**Files:** Create `scripts/qualification.mjs`、`tests/core/qualification.test.ts`; Modify `scripts/release-gate.mjs`、`scripts/package-smoke.mjs`、`scripts/soak.mjs`、`.github/workflows/release-gate.yml`、`docs/release-support.md`、`docs/architecture-capabilities.md`、`README.md`。

**Interfaces:** Consumes 各任务能力探测与事件/结果；Produces `Qualification {revision:string,artifactSha256:string,platform:string,nodeVersion:string,dependencyVersions:Record<string,string>,capability:string,status:'passed'|'failed'|'unsupported'|'not-run',evidence:string[]}` 和 `validateQualification(record:unknown):Qualification`，后者对无真实 evidence 的 passed 抛错。只有实际运行成功可记 passed。

- [ ] 写资格 schema 校验：仅存在 CI 文件不能标 passed；mock LSP 不能作 native 资格；工具名存在不能作接线通过；unsupported 不作为测试 skip 掩盖失败。运行 `pnpm exec vitest run tests/core/qualification.test.ts` 确认目标失败后实现校验。
- [ ] 增量将 native Windows/Linux、真实 LSP、MCP 本地/HTTP、CLI/Ink/JSONL、进程恢复和历史数据 fixture 接入资格矩阵；可选 tmux/SSH/账号功能单列，不拖累基本离线包安装。
- [ ] 跑 `pnpm exec tsc --noEmit`、`pnpm run lint`、`pnpm exec vitest run`、`pnpm run build`、`pnpm run test:package`、`pnpm run soak:short`。clean checkout 后 `pnpm run release:gate`；平台/真实模型未跑项明确标 not-run。
- [ ] 在 T01 固定任务上比较修改前后同模型/同预算，报告成功、误改、费用、时延、介入及恢复；不达标不扩大默认模块，不删失败任务改成功率。
- [ ] 审查重复服务是否真正收敛、兼容配置是否可恢复、README 是否匹配已验收能力；独立全分支审查，提交并按用户已有 GitHub 授权推送正常分支，禁止强推。

## 覆盖自检

| 差距 | 负责交付 |
| --- | --- |
| G01 / G02 / G03 | T02 / T03 / T04-L / T04-W / T16 |
| G04 / G28 | T07 |
| G05 | T08 |
| G06 / G07 / G08 | T05 / T06 |
| G09 / G10 | T10 |
| G11 / G12 | T12 |
| G13 / G14 | T09 |
| G15 / G16 | T15 / T14 |
| G17 / G18 / G22 | T13 / T16 |
| G19 / G20 | T16 / T17 |
| G21 / G23 | T18 / T19 |
| G24 / G25 | T01 / T21 |
| G26 / G27 | T11 / T20 |

完成计划时已自查差距覆盖、任务输入输出、五类重点失败模式和分组依赖。本文件所有复选框均未执行；不能把接口签名、未来用例或资格矩阵当作当前支持声明。原生隔离、PTY 和真实 provider 的资格需独立证据，工期取决于平台原型及测量结果。
