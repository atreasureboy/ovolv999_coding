# ARTEX Loop Controller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让前台 Loop 从真实失败证据继续修复，持久保留次数与进度，在重复失败、审批、限额和不确定副作用出现时可靠停止。

**Architecture:** 在现有 AgentSessionClient/AgentService 上接入薄控制器，沿用执行、预算、工作区互斥和独立验收。会话内账本记录 prepared → dispatched → settled → checkpointed；只有完整检查点允许恢复。模型上下文是有界任务投影，canonical history 继续由现有服务维护。

**Tech Stack:** TypeScript strict、Node.js >=22.13.0、ESM、现有文件持久化与 Vitest；不增加依赖。

**Spec:** [已确认设计，第六节为本批范围](../specs/2026-10-22-artex-workflow-adoption-design.md)。基线提交 `ecef84ac4599906810167b051d9dfc570144ce82`。

状态：用户于 2026-10-22 批准全部六项任务；2026-10-23 第一批实现与验证完成；2026-10-25 完成交付文档收尾。六项任务均已完成独立审查；初次整分支审查的唯一 Important F1 已修复，唯一局部独立复核确认 F1 ADDRESSED，无新增 Critical/Important/Minor 问题、无剩余可执行发现。最终交付保留并行全量三项未解释超时与两项实际 EPERM 文件 symlink 跳过的验证限制。实际证据见设计文档第八节及[持久决策记录](../decisions/2026-10-22-artex-loop-controller.md)；原设计与执行日期保留。

## Global Constraints

- 保持 `.loop/GOAL.md`、`.loop/ACCEPTANCE.md`、现有 CLI 参数和退出状态兼容。
- 默认最大轮数沿用 12；连续相同失败且产物未变的停滞阈值为 3，保存后恢复不得重置。
- 接入 service 后显式采用现有每 turn 10 分钟期限及有界清理；保留 `AGENT_FINALIZATION_GRACE_MS = 3000`。
- 第一批不新增任务级总 Token/费用账户，仍使用项目预算和未结 reservation。
- 第一批保证“完整检查点之间恢复”，不承诺任意指令位置的自动接管。
- 人工取消不触发新的模型收尾轮；只做有界的本地持久化和既有资源清理。
- 不复制 ARTEX 源码、提示词或界面；独立实现，只借鉴架构。
- 不新增后台 Loop、cron、依赖 DAG、跨提交自动重放、通用知识图或 Web 控制台；回归既有后台单任务。
- 遵守 AGENTS.md：不新增源码注释；测试放在 tests/；不用全局 goals.json 保存执行历史。
- 每项先建立有意义的失败用例再实现。每项提交只包含自身文件；不覆盖用户改动，不在未验证时宣称完成。

## Review Focus

1. 同轮既有普通工具失败又有审批/预算停止：停止事实不得被后续成功或验收失败覆盖。任务 1、3、5。
2. 进程在提交确认或最终落盘前死亡：可能已经写入，恢复不得补投、退还次数或认可伪造凭据。任务 2、5、6。
3. Windows 大小写/junction、锁票变化、损坏账本及逃逸证据路径：身份必须一致，失去所有权后不得发布检查点。任务 2、4。
4. 日志、时间戳和 STATE.md 不断变化而代码没变：仍应停滞；未跟踪代码和会话内用户报告则应算产物。任务 3、4、6。
5. 超长多字节诊断、凭据及历史 provider 状态：反馈有界、可定位证据，不泄露内部状态，也不裁剪 canonical history。任务 3、5。

---

## 文件与职责

| 文件 | 职责与归属 |
| --- | --- |
| `src/core/outcome.ts`、`src/core/types.ts` | 宿主结构化终止原因及向后兼容类型，任务 1 |
| `src/core/budget.ts`、`src/core/modelGateway.ts`、`src/core/engine.ts`、`src/core/engine/approval.ts`、`src/core/engine/acceptance.ts`、`src/core/runContext.ts`、`src/core/workspaceLease.ts`、`src/tools/agent.ts` | 在实际决定处产生原因，并保留父子执行与混合失败中的停止事实，任务 1 |
| `src/core/agentService.ts`、`src/core/agentEventStore.ts` | 服务期限/steering/恢复原因与持久校验，任务 1 |
| 新建 `src/core/autonomy/types.ts` | 仅定义本批共享的账本、证据及决策类型，任务 2 |
| 新建 `src/core/autonomy/attemptStore.ts` | 唯一权威账本、阶段转换、有界证据与锁保护，任务 2 |
| 新建 `src/core/autonomy/continuation.ts`、`context.ts` | 纯续跑决策、停滞指纹、脱敏且有界的反馈，任务 3 |
| 新建 `src/core/artifactInventory.ts`、`artifactPolicy.ts`；修改 `verification.ts` | 从现有 verification 提取扫描职责，增加 Loop 的精确运行文件排除策略；保留旧导出和其他入口默认行为，任务 4 |
| `agentSessionClient.ts`、`loopEngine.ts`、`runContext.ts` | 客户端单轮事件回调、Loop 编排、工作区内最终提交，任务 5 |
| `bin/ovogogogo.ts`、`src/cli/args.ts`、`src/cli/help.ts`、`README.md` | 唯一客户端绑定、恢复入口、参数来源、期限及恢复说明，任务 6 |

执行顺序为 1 → 2 → 3 → 4 → 5 → 6。任务 2 与 4 可独立研究，落地时保持上述顺序，避免共同修改 verification/engine 的冲突。不并行编辑同一个文件。

## 任务 1：把可修复验收失败与必须停止的原因区分开

**Files:** 修改文件见文件职责表标注“任务 1”的三行；测试扩展 `tests/engineContract.test.ts`、`tests/verificationEvidence.test.ts`、`tests/core/engine/approvalWiring.test.ts`、`tests/core/engine/modelBudgetRecovery.test.ts`、`tests/core/engine/timeoutOutcome.test.ts`、`tests/integrations/agentService.test.ts`、`tests/core/agentEventStore.test.ts`。

**Interfaces:** 沿用 OutcomeStatus 和 TurnResult.reason；在 ToolResult、TurnResult、VerificationEvidence、ChildEngineLike.result 增加可选 `outcomeReason?: OutcomeReason`。在 outcome.ts 提供以下类型、校验及错误载体：

```ts
type OutcomeReason =
  | { code: 'permission_denied'; source: 'policy' | 'approval' | 'hook'; requestId?: string }
  | { code: 'approval_required' | 'approval_stale'; requestId?: string }
  | { code: 'budget_denied'; kind: 'requests' | 'tokens' | 'cost' | 'context' | 'pricing' }
  | { code: 'recovery_required'; scope: 'operation' | 'workspace' | 'budget' | 'session' | 'resources' }
  | { code: 'acceptance_failed' | 'acceptance_invalidated' | 'verification_unavailable' | 'turn_deadline' | 'steering_pending' }
function isOutcomeReason(value: unknown): value is OutcomeReason
class OutcomeError extends Error {
  constructor(message: string, outcomeReason: OutcomeReason, options?: ErrorOptions)
  readonly outcomeReason: OutcomeReason
}
```

- [x] **1. 写失败测试。** 扩展真实引擎/审批/预算夹具，断言如下；不要仅测试手工构造的结果：

```ts
expect(policyDenied.outcomeReason).toEqual({ code: 'permission_denied', source: 'policy' })
expect(mixedFailure.status).toBe('needs_input')
expect(mixedFailure.outcomeReason?.code).toBe('approval_required')
expect(budgetRejected.outcomeReason).toEqual({ code: 'budget_denied', kind: 'requests' })
expect(requestCountAfterRejectedReservation).toBe(requestCountBefore)
expect(corruptBudget.outcomeReason).toEqual({ code: 'recovery_required', scope: 'budget' })
expect(cleanNonzeroExit.outcomeReason?.code).toBe('acceptance_failed')
expect(sourceChangedDuringCheck.outcomeReason?.code).toBe('acceptance_invalidated')
expect(timedOutCheck.outcomeReason?.code).not.toBe('acceptance_failed')
expect(reopenedService.lastTurn?.result?.outcomeReason).toEqual(originalReason)
```

增加明确人工 deny、child deny 与 sibling 成功、失败结果叠加未消费 steering、未知文案伪装“验收失败”、未结资源、旧无原因字段事件可读、未知原因枚举拒绝的测试。原因 requestId 最长 256 字符，禁止任意错误对象/参数进入该字段。

- [x] **2. 运行红灯。** `npx vitest run tests/engineContract.test.ts tests/verificationEvidence.test.ts tests/core/engine/approvalWiring.test.ts tests/core/engine/modelBudgetRecovery.test.ts tests/core/engine/timeoutOutcome.test.ts tests/integrations/agentService.test.ts tests/core/agentEventStore.test.ts --maxWorkers=2`。预期新断言失败在缺少原因或停止状态被覆盖；排除夹具启动错误。
- [x] **3. 实现原因产生与传播。** budget 在额度/缺价格/损坏存储的实际分支分类；modelGateway 将请求前 context 超限标记为 budget_denied/context，预算结算失败标记为 recovery_required/budget，保留未结 reservation；engine 两处 catch 保留 OutcomeError。审批从真实决定产生原因；父子 ToolResult 透传。RunContext 增加 `stopReason?: OutcomeReason` 保存宿主停止事实，后续同输入成功不能抹去。优先保留 cancelled/interrupted，再处理恢复、审批、权限、限额/期限、steering；普通 failed 不覆盖这些事实。service 对未消费 steering 的 failed 结果也保留停止原因；恢复原因持久进入事件 reducer。
- [x] **4. 严格标记验收失败。** `executeVerification()` 仅在计划检查全部结束、至少一个真实非零退出、无 null exit/取消/超时/未结资源、最终目标产物及定义仍一致时产生 acceptance_failed。启动异常/不可执行为 verification_unavailable，版本漂移为 acceptance_invalidated；未知错误保持 failed 且没有可继续标记。内部超时分类使用宿主类型信息，不在新控制器匹配文案。对既有终态映射有改变的地方写明确回归断言。

状态映射固定为：permission_denied→failed；approval_required→needs_input；approval_stale/recovery_required/acceptance_invalidated→blocked；budget_denied 的 requests/tokens/cost/context→limit_reached、pricing→blocked；acceptance_failed/verification_unavailable→failed；turn_deadline→limit_reached（有未结资源时 blocked）；steering_pending→interrupted。已有 cancelled/interrupted 不被一般失败覆盖，未结资源仍保留恢复原因；停止原因不能被成功结果覆盖。

- [x] **5. 运行绿灯并提交。** 重跑步骤 2 与 `npx tsc --noEmit`，均须退出 0；检查原因没有因事件截断而丢失。提交 `fix: preserve structured stop reasons across agent execution`。

## 任务 2：建立有所有权保护的尝试账本

**Files:** 新建 `src/core/autonomy/types.ts`、`attemptStore.ts`、`tests/core/autonomy/attemptStore.test.ts`、`tests/fixtures/loopAttemptCrash.mjs`。复用 `persistenceLock.ts`、`workspaceLease.ts`、`agentEventStore.ts` 的原子提交模式，不改造全局 Goal 存储。

**Interfaces:** 所有公开类型在 autonomy/types.ts 定义；既有 TurnResult、VerificationEvidence、OutcomeReason 直接导入。下列数据只存字段白名单，不存聊天/provider 对象：

```ts
type AttemptPhase = 'prepared' | 'dispatched' | 'settled' | 'checkpointed'
type LoopDecision = { action: 'continue' } | { action: 'stop'; status: OutcomeStatus; reason?: OutcomeReason; detail: string }
type LoopEvidence = VerificationEvidence & { failureFingerprint?: string; truncated: boolean }
type LoopEvidenceRef = { path: string; sha256: string; bytes: number; truncated: boolean }
type LoopStagnation = { count: number; fingerprint?: string; artifactVersion?: string }
type LoopTerminal = {
  threadId: string; turnId: string; finishedSequence: number; historyRevision: number
  status: OutcomeStatus; reason: TurnResult['reason']; outcomeReason?: OutcomeReason
  unfinishedResources: string[]
}
type LoopCheckpoint = {
  artifactVersion: string; evidence: LoopEvidenceRef; verificationSource: 'turn' | 'loop'; stagnation: LoopStagnation
  decision: LoopDecision; acceptedAt?: string
}
type LoopAttempt = {
  id: string; ordinal: number; phase: AttemptPhase
  turn?: { threadId: string; turnId: string }; terminal?: LoopTerminal; checkpoint?: LoopCheckpoint
}
type LoopIdentity = { workspace: string; sessionId: string; goalHash: string; definitionHash: string }
type LoopState = LoopIdentity & {
  schemaVersion: 1; taskId: string; revision: number; maxIterations: number
  stagnationLimit: number; consumedIterations: number; stagnation: LoopStagnation
  current?: LoopAttempt; previousCheckpoint?: LoopCheckpoint
}
```

`LoopAttemptStore.open(options: { sessionDir: string; mode: 'create' | 'resume'; identity: LoopIdentity; maxIterations: number; stagnationLimit: number; signal?: AbortSignal }): Promise<LoopAttemptStore>` 返回持有唯一 persistence lease 的 store。其方法签名为：

```ts
snapshot(): LoopState
prepare(expectedRevision: number): LoopState
dispatch(attemptId: string, expectedRevision: number, turn: { threadId: string; turnId: string }): LoopState
settle(attemptId: string, expectedRevision: number, terminal: LoopTerminal): LoopState
writeEvidence(attemptId: string, evidence: LoopEvidence): LoopEvidenceRef
readEvidence(reference: LoopEvidenceRef): LoopEvidence
checkpoint(attemptId: string, expectedRevision: number, value: LoopCheckpoint, assertWorkspaceOwned: () => void): LoopState
revalidate(expectedRevision: number, value: LoopCheckpoint, assertWorkspaceOwned: () => void): LoopState
close(): void
```

`writeEvidence` 只接受任务 3 已脱敏有界的证据；ref 路径相对 `sessionDir/loop-controller/`。revalidate 仅用于已 checkpointed 的旧成功记录在当前产物上的重新验收，不创建 turn，不增加/退还次数。

- [x] **1. 写失败测试。** 测试名称及关键断言：

```ts
// reserves one iteration before submission and never refunds an ambiguous attempt
expect(reopened.consumedIterations).toBe(1)
expect(reopened.current?.phase).toBe('prepared')
// rejects stale revisions, changed identities and a writer that lost its lease
expect(() => staleStore.prepare(oldRevision)).toThrow()
expect(readAuthoritativeState()).toEqual(beforeRejectedWrite)
// refuses preparing another attempt while any incomplete phase is present
expect(() => reopenedStore.prepare(reopened.revision)).toThrow()
// preserves the last valid file when publication is interrupted
expect(reopened.revision).toBe(lastCommittedRevision)
```

覆盖真实子进程在 prepare 后/settle 后被终止、双 writer 竞争、证据损坏/超大/`../`/symlink、未知 schema、Windows junction/case 身份。测试只清理自身临时目录。

- [x] **2. 运行红灯。** `npx vitest run tests/core/autonomy/attemptStore.test.ts --maxWorkers=2`，预期缺少模块或新行为失败。
- [x] **3. 实现账本和阶段状态机。** 权威文件为 `S/loop-controller/state.json`，单文件最多 256 KiB；每份证据最多 256 KiB，独立命名、摘要绑定、不可覆盖，先写证据后引用。完成的 attempt 另存为 `attempts/<ordinal>-<uuid>-<revision>.json`，包含身份、terminal 与 checkpoint，供追溯；恢复只认权威 state 已引用的检查点，不自动采纳遗留文件。使用专属 lease、revision CAS、私有文件校验、同目录临时文件、fsync、rename 前 assertOwned；未知 owner 不抢占。prepare 原子增加 consumedIterations，提供零个 refund API；未完成阶段、终止决定或轮数耗尽均拒绝再次 prepare。越级转换与重复提交不同 turnId 一律拒绝，同值重复事件不得重复计数。
- [x] **4. 完成恢复与引用验证。** create 不覆盖旧账本，resume 不创建缺失账本；canonical workspace/session/目标/定义必须匹配，旧上限由磁盘决定。读取损坏文件明确失败并保留原物；证据引用不依赖会被 service pruning 清除的 agent-results。previousCheckpoint 在准备新一轮时保留；pending 阶段不能借用它假装当前轮完整。损坏、失去所有权和提交结果未知使用任务 1 的 OutcomeError，原因为 recovery_required/session；目标或定义不符使用 acceptance_invalidated。未知系统异常保留原 cause，不改写成可重试失败。
- [x] **5. 运行绿灯并提交。** 重跑步骤 2 与类型检查，故障注入必须证明旧记录未被覆盖且次数不减少。提交 `feat: persist loop attempts with guarded checkpoints`。

## 任务 3：实现有界失败反馈与停滞决策

**Files:** 新建 `src/core/autonomy/continuation.ts`、`context.ts`、`tests/core/autonomy/continuation.test.ts`、`context.test.ts`；使用任务 2 的 types.ts。

**Interfaces:**

```ts
type LoopObservation = {
  status: OutcomeStatus; reason?: OutcomeReason; verification: LoopEvidence
  artifactVersion: string; cancelled: boolean; recoveryRequired: boolean
  pendingApproval: boolean; steeringPending: boolean; unfinishedResources: readonly string[]
}
function decideContinuation(state: LoopState, observation: LoopObservation): { decision: LoopDecision; stagnation: LoopStagnation }
function fingerprintFailure(evidence: VerificationEvidence): string | undefined
function sanitizeLoopEvidence(evidence: VerificationEvidence, knownSecrets: readonly string[]): LoopEvidence
function buildLoopContext(input: {
  state: LoopState; goal: string; acceptance: string; stateNote: string
  previous?: { evidence: LoopEvidence; reference: LoopEvidenceRef }
  artifactChanged: boolean; knownSecrets: readonly string[]
}): { messages: OpenAIMessage[]; prompt: string; truncated: boolean }
```

前三个类型/函数分别放 continuation.ts，后两个函数放 context.ts；LoopObservation 从 continuation.ts 导出。上下文合计以 `Buffer.byteLength(JSON.stringify({ messages, prompt }))` 限制为 32 KiB；单条失败输出最多 8 KiB，证据合计最多 256 KiB。不足以完整放入目标/诊断时附源文件/证据引用和明确截断标志，不能静默丢弃。

- [x] **1. 写失败测试。** 使用表驱动覆盖每种停止事实，并固定边界：

```ts
expect(sameFailureDecisions).toEqual(['continue', 'continue', 'blocked'])
expect(afterMeaningfulArtifactChange.stagnation.count).toBe(1)
expect(afterChangedDiagnostic.stagnation.count).toBe(1)
expect(afterPidAndTimestampOnlyChange.stagnation.count).toBe(3)
expect(unknownFailed.decision).toMatchObject({ action: 'stop', status: 'failed' })
expect(noIterationsLeft.decision).toMatchObject({ action: 'stop', status: 'limit_reached' })
expect(Buffer.byteLength(JSON.stringify({ messages: context.messages, prompt: context.prompt }))).toBeLessThanOrEqual(32768)
expect(serializedContext).toContain(evidenceReference.path)
expect(serializedContext).not.toContain(secretFixture)
expect(serializedContext).not.toMatch(/providerState|reasoning_content/)
```

验证 cancelled/interrupted/needs_input/恢复/限额/steering 优先于 acceptance_failed；旧无分类 failed 停止。覆盖 ANSI、CRLF、中文/emoji、超长命令、同命令不同真实诊断、凭据恰好跨截断边界。

- [x] **2. 运行红灯。** `npx vitest run tests/core/autonomy/continuation.test.ts tests/core/autonomy/context.test.ts --maxWorkers=2`，预期缺少模块或规则失败。
- [x] **3. 实现纯决策。** 不读文件、不运行模型/命令。只有明确 acceptance_failed 且无停止事实的 failed 可继续；同失败与同 artifact 连续计数，否则重置为 1。指纹按失败命令顺序包含命令身份、kind/scope、退出码及归一化诊断；只移除 ANSI、明确 ISO 时间戳及标注 PID 的值，统一换行，不删除所有数字/行号。sanitizeLoopEvidence 在截断前调用 fingerprintFailure 并保存 failureFingerprint，decideContinuation 使用该持久值，摘要截断不得让不同错误变成同一错误。通过当前任务验收可完成；达到第三次先报停滞 blocked，尚未停滞但轮数耗尽则 limit_reached。
- [x] **4. 实现上下文投影。** 固定字段白名单，先完整脱敏再按 UTF-8/JSON 字节截断，复用 secretScanner 的扫描与 eventText 的字节边界处理，额外替换已知实际模型凭据及标注的 token/password。只加入任务、次数、上一失败的命令/退出码/诊断、产物是否改变及证据位置；失败条目固定展示 command、exitCode、output 标签，失败诊断优先于成功检查输出分配字节预算。STATE.md 标成非权威笔记，不传整段历史、内部 reasoning 或 provider continuation。LoopEvidence.truncated 和引用的 truncated 一致；保留截断前指纹，不能从模型文本设置可重试原因。
- [x] **5. 运行绿灯并提交。** 重跑步骤 2 和类型检查。提交 `feat: add bounded loop feedback and stagnation decisions`。

## 任务 4：让验收和停滞使用同一份真实产物清单

**Files:** 新建 `src/core/artifactInventory.ts`、`artifactPolicy.ts`；修改 `src/core/verification.ts`、`src/core/types.ts`、`src/core/engine.ts`、`src/core/engine/acceptance.ts`、`src/core/usageLedger.ts`；扩展 `tests/verificationEvidence.test.ts`，新建 `tests/core/artifactPolicy.test.ts`。

**Interfaces:** 将既有 `captureArtifactVersion()`、`ArtifactScanOptions` 原实现移到 artifactInventory.ts，verification.ts 原名 re-export，保持默认扫描行为。新策略在 artifactPolicy.ts 定义：

```ts
type LoopArtifactPolicy = {
  mode: 'loop'; workspace: string; loopDir: string; sessionDir: string
  budgetPath: string; runtimeRoot: string; usageRoot: string; eventLogPath?: string
}
function createLoopArtifactPolicy(input: Omit<LoopArtifactPolicy, 'mode'>): LoopArtifactPolicy
function isLoopRuntimeArtifact(path: string, policy: LoopArtifactPolicy): boolean
```

`ArtifactScanOptions`、`VerificationPlan` 和 `EngineConfig` 均添加 `artifactPolicy?: LoopArtifactPolicy`；`createVerificationPlan(cwd, commands?, runtimePaths?, kinds?, artifactPolicy?): VerificationPlan` 增加可选第五参数。策略规范化、冻结后纳入 definitionHash，不能每轮把新 UUID 枚举进定义。UsageLedger 增加 `getRoot(): string` 获取实际自定义根。

- [x] **1. 写失败测试。** 建真实 Git/non-Git 临时工作区，断言：

```ts
expect(hashAfterStateAndRuntimeWrites).toBe(initialHash)
expect(hashAfterUntrackedSourceWrite).not.toBe(initialHash)
expect(hashAfterIgnoredNativeSourceWrite).not.toBe(initialHash)
expect(hashAfterSessionReportWrite).not.toBe(initialHash)
expect(hashAfterLoopProductWrite).not.toBe(initialHash)
expect(hashAfterOvogoSettingsWrite).not.toBe(initialHash)
expect(hashAfterSameNamedLogInAnotherDirectory).not.toBe(initialHash)
expect(definitionAfterNewReceiptUuid).toBe(initialDefinition)
```

测试 `OVOGO_STATE_DIR` 与 budgetRoot 在工作区内、预算写入/lease heartbeat 跨验收前后、已跟踪 STATE.md、路径别名、不安全越界路径。现有扫描超时、文件数、字节、修改检测测试仍须通过。

- [x] **2. 运行红灯。** `npx vitest run tests/verificationEvidence.test.ts tests/core/artifactPolicy.test.ts --maxWorkers=2`，预期当前整目录忽略或动态状态影响产物的行为不符合新断言。
- [x] **3. 提取扫描器并实现有根边界的排除规则。** Loop 模式取消 `.loop/.ovogo` 和任意位置运行文件 basename 的整体忽略；保留已有 `.git/node_modules/dist/build` 等构建目录策略。绑定实际 L/S/R/B/usage/eventLog 根，只忽略下列宿主管理位置，生成报告及其他任意同名文件继续计算：
  - L 下四个控制文件 STATE.md/DONE.flag/OUTCOME.json/PARKED.flag；GOAL/ACCEPTANCE/config.json 均纳入。
  - S 下 history.json、writer 锁票、agent-model-window.json、events.ndjson 及其既有临时/轮转格式；agent_events.ndjson；新增专属 loop-controller。
  - S 下 agent-events、agent-results、usage、file-history、tool-results、task-outputs、agent-logs 中符合各写者格式的文件；不排除整个 S，也不排除这些目录里格式不符的用户文件。
  - 实际 budget 文件及锁票/临时文件；R 下当前 workspace lease 文件、合法 run record 及其锁票/临时格式；不能排除 R 或 `.ovolv999` 整体。
  - 默认 `.bg_logs/.shell_logs` 下工具创建格式的日志，以及根级 ovogo_progress.json；显式自定义 log_dir 的用户文件默认纳入，不能凭模型参数扩张排除根。
  - 主仓库 `.ovolv999/worktrees.json` 及其持久化临时/锁票；worktree 中代码不因这一规则被排除。
- [x] **4. 贯通同一策略。** engine 的首次/最终/收尾后扫描和 controller 的验收前后/恢复扫描全部消费 artifactPolicy；不要只对停滞计算另造较弱 hash。Loop 不再把整个 sessionDir 放进 excludedPaths。配置路径在构造时规范化；模式不对外接受任意正则/目录黑名单。已有其他入口不传策略时行为保持。
- [x] **5. 运行绿灯并提交。** 重跑步骤 2、`tests/core/engine/modelBudgetRecovery.test.ts` 与类型检查。提交 `fix: distinguish loop runtime records from user artifacts`。

## 任务 5：把 Loop 接入服务、持久检查点与恢复

**Files:** 修改 `src/core/agentSessionClient.ts`、`src/core/loopEngine.ts`、`src/core/runContext.ts`；扩展 `tests/integrations/agentSessionClient.test.ts`、`tests/loopOutcome.test.ts`、`tests/core/loopAcceptanceAtomicity.test.ts`、`tests/core/loopWorkspaceAudit.test.ts`；新建 `tests/integrations/loopController.test.ts`。

**Interfaces:**

```ts
interface AgentTurnLifecycle { onEvent?: (event: AgentEvent) => void | Promise<void> }
// AgentSessionClient 保留前三个实参，新参数在尾部
runTurn(text: string, images?: readonly { path: string; dataUrl: string }[], onPromptSubmit?: (signal: AbortSignal) => unknown, lifecycle?: AgentTurnLifecycle): Promise<{ result: TurnResult; newHistory: OpenAIMessage[] }>
// withWorkspaceAccess 保持前四个参数，旧无参数回调仍兼容
withWorkspaceAccess<T>(cwd: string, familyId: string, write: boolean, signal: AbortSignal, operation: (assertOwned: () => void) => Promise<T>): Promise<T>
interface LoopConfig {
  cwd: string; loopDir: string; maxIters: number; maxItersExplicit?: boolean
  resume?: boolean; signal?: AbortSignal
  onPromptSubmit?: (text: string, signal: AbortSignal) => unknown
}
runLoop(client: AgentSessionClient, renderer: Renderer, config: LoopConfig): Promise<LoopResult>
```

保留 runLoop 导出及 LoopResult 原有字段，另加 `outcomeReason?: OutcomeReason`、`detail?: string`；runId 为恢复前后一致的 taskId，iterations 为累计 consumedIterations。仓内调用点全部迁移，不保留直接 engine.runTurn 的旁路。客户端 sessionDir 是唯一会话位置来源。

- [x] **1. 写失败测试。** 用真实 AgentSessionClient + 本地 HTTP provider，覆盖第一轮独立验收失败、第二轮实际请求含命令/退出码/诊断并修复；断言 canonical history 未被 replaceModelWindow 截短。客户端 lifecycle.onEvent 先于渲染回调运行，started/finished 回调异常中断并回收，不能放行下一轮。关键断言：

```ts
expect(secondModelRequest).toContain('node check.cjs')
expect(secondModelRequest).toContain('exitCode: 1')
expect(secondModelRequest).toContain('EXPECTED_FIXTURE_FAILURE')
expect(result.status).toBe('completed')
expect(savedHistory.length).toBeGreaterThan(client.getModelWindow().length)
expect(receiptSeenByQueuedWriter.taskId).toBe(checkpointSeenByQueuedWriter.taskId)
expect(submissionsAfterAmbiguousResume).toBe(0)
expect(iterationsAfterAmbiguousResume).toBe(iterationsBeforeRestart)
```

增加 goal/criteria 改写、DONE.flag 伪造、验收中/检查点后外部写入、审批断开、取消、未消费 steering、预算拒绝、每 turn 短期限注入与未结进程测试。当前 loopWorkspaceAudit 的 `.loop/checked.txt` 哨兵会成为真实产物，移到测试工作区之外，不能扩大产品排除规则使旧夹具过关。

- [x] **2. 运行红灯。** `npx vitest run tests/integrations/agentSessionClient.test.ts tests/integrations/loopController.test.ts tests/loopOutcome.test.ts tests/core/loopAcceptanceAtomicity.test.ts tests/core/loopWorkspaceAudit.test.ts --maxWorkers=2`，预期新增接口/真实调用链断言失败。
- [x] **3. 接入客户端并建立单轮事件绑定。** Loop 先初始化 client 并打开 store；在空闲时 replaceModelWindow，仅传新投影。先 prepare 持久预占，再调用 runTurn；其单轮事件回调将 turn.started 绑定为 dispatched，将 turn.finished 的 sequence/historyRevision/白名单结果存为 settled。回调必须位于客户端现有 try/finally 与取消路径中。start 已可开始执行，回调不是执行前屏障；事件丢失仍按未知提交处理，绝不补投。
- [x] **4. 实现受保护的验收提交。** settled 后依据原因决定停止或执行冻结 Loop 检查。服务自身 acceptance_failed 的证据可用于下一轮反馈，但不能代替 Loop 的最终验收；checkpoint.verificationSource 区分 turn 与 loop，只有后者且证据 definitionHash 与任务定义相同才可完成。在同一 withWorkspaceAccess 回调内重新核对 GOAL/ACCEPTANCE、definitionHash、artifactVersion，写脱敏证据与兼容 DONE/OUTCOME，再最后原子提交权威 checkpoint；每次发布前检查 store 和 workspace 所有权，提交成功后才报告成功。兼容文件保留既有 runId/goalHash/artifactVersion/definitionHash/iteration 字段，新增 taskId 与 checkpointRevision；它们从来不是恢复权威。取消仅持久记录已知结果并清理；剩余未知阶段保留待恢复，不发收尾模型请求。
- [x] **5. 实现精确恢复。** 读取只读服务 snapshot，核对 threadId、turnId、finishedSequence、historyRevision、pending approval/recovery 和现有 operation recovery；不创建第二个 service。prepared/dispatched/settled 一律 blocked + recovery_required，保留已消耗次数。checkpointed 且 decision=continue 才可自动派下一轮；终止决定不因重启消失。旧 completed 在 lease 内三版本仍匹配才复用；artifact 改变但目标/定义未变时重新执行独立验收，以 revalidate 更新同一检查点，不增加模型轮次。失败后只有剩余预算和可修复分类允许下一轮；目标/定义改变则阻塞，要求新建已审阅任务。
- [x] **6. 完成配置与错误路径。** 可选 `.loop/config.json` 仅支持 `{ "stagnationLimit": 3 }`，正安全整数，缺省 3；读取上限 64 KiB，格式错误明确 blocked。任务创建后阈值冻结，恢复不覆盖。maxIters 显式冲突拒绝，默认/环境值差异提示沿用旧值。PARKED 保持 blocked；取消/服务 typed recovery/写盘失败不重试。每轮开始重新读取上一检查点证据引用，证据写盘失败不降级为“只有日志也继续”。
- [x] **7. 运行绿灯并提交。** 重跑步骤 2、任务 2–4 的测试和类型检查。提交 `feat: run loop through durable agent sessions and guarded recovery`。

## 任务 6：接通真实 CLI，完成跨进程验收与交付说明

**Files:** 修改 `bin/ovogogogo.ts`、`src/cli/args.ts`、`src/cli/help.ts`、`README.md`；扩展 `tests/cli/args.test.ts`；新建 `tests/cli/loopLifecycle.test.mjs`、`tests/fixtures/loopControllerChild.mjs`。复用 `scripts/release-utils.mjs` 和本地 provider 夹具；必要的测试 HTTP 响应逻辑留在新夹具，不改变默认 package smoke 行为。

**Interfaces:** Args 增加 `loopMaxItersExplicit: boolean`，只有 `--loop-max-iters` 置 true，不顺手改变现有数字前缀解析兼容。CLI 为 Loop 创建一个 client，使用现有 `createAgentEventRenderer` 渲染事件，调用 bindClient；传入 resumedHistory、onPromptSubmit hook 与 lifecycleController.signal。初始化时配置任务 4 的 artifactPolicy。

- [x] **1. 写真实入口失败测试。** 编译 CLI 并启动独立子进程，隔离 HOME/runtime/budget，provider 仅监听 127.0.0.1；Windows 使用现有 execution-host 构建流程。至少覆盖：
  - `--loop` 两轮修复成功，读取真实第二次 HTTP payload，完成时退出 0，服务/账本次数一致且会话锁已释放。
  - 相同失败三轮退出 2；每轮只改 STATE.md/时间戳仍在第三轮 blocked；有效代码变更重置计数。
  - 在完整失败 checkpoint 后子进程退出，`--loop --resume <session>` 保留次数、失败反馈、停滞和项目 request budget；下一轮预算拒绝不发 HTTP。
  - prepared 提交确认前、真实写入后 receipt 前、turn.finished 后 checkpoint 前，分别用 IPC 屏障终止子进程；恢复退出 2，不增加 provider 请求、不重复文件副作用、次数不退还。
  - `--continue` 最新普通会话/无会话明确拒绝；不寻找更老账本、不新建重置；指定 resume 的错误 workspace/目标/阈值/显式 maxIters 冲突均拒绝。
  - 完成后外部改代码，再恢复必须重新验收，不能直接输出旧完成；目标/验收文件变化则阻塞。
  - headless 审批 needs_input、用户取消 130、服务限额 124；不产生额外收尾调用。
  - 既有 `--bg task` 用真实 worker + 本地 provider 完成、保存 outcome 并释放锁，不用替换 worker 的环境变量冒充入口接通。

跨进程断言至少检查 `exitCode / provider 请求数 / 副作用计数 / ledger consumedIterations / phase / durable outcome`，不只匹配控制台文字。CLI 夹具 stdin 关闭且内容为空，避免现有管道输入优先分支转为单任务。新增故障 IPC 只存在测试夹具，不在产品中增加 crash 环境开关。

- [x] **2. 运行红灯。** `npx vitest run tests/cli/loopLifecycle.test.mjs tests/cli/args.test.ts --maxWorkers=2`，预期入口缺少持久反馈/恢复接线。
- [x] **3. 完成 CLI 和说明。** 在 Loop 分支构造并 bind 唯一客户端，沿用现有有界 cleanup。Loop --continue 无可恢复账本时不得退回 createSessionDir。显示“每轮最多 10 分钟”、累计轮数、实际恢复上限和明确停止原因。help/README 给出新建、恢复、停滞配置和不确定提交需人工恢复的示例；明确本批不支持后台 Loop。保留普通 task/stdin/REPL/后台原有选择语义，不扩张审批 host。
- [x] **4. 运行入口与相关回归。** 步骤 2 加 `tests/cli/entryLifecycle.test.mjs`、`tests/backgroundOutcome.test.ts`、`tests/backgroundProcessLifecycle.test.ts`、`tests/integrations/agentService.test.ts`，全部退出 0。期限路径在服务测试注入短 deadline；真实 CLI 检查使用默认期限及提示，测试不等待十分钟。
- [x] **5. 完成全量验证。** `npx tsc --noEmit`、`npx vitest run --maxWorkers=2`、`npm run build`、`npm run test:package`，记录各自退出码、通过/跳过数及失败限制。针对改变过的文件做 diff 审查，确认无 source 注释、真实凭据、无关重构或新增依赖。模型质量提升不能由本地固定响应夹具推断。
- [x] **6. 更新证据并提交。** 在设计文档第八节追加本批实际验证结果与能力边界，保留原基线日期。提交 `feat: expose resumable loop control through the CLI`；完成整分支独立审查后再交付。GitHub 远程操作沿用本会话已明确授权的范围，不把本计划评阅当成新增发布授权。

## 覆盖与自检

| 设计 6.4 验收条目 | 实现和验收任务 |
| --- | --- |
| 1 真实失败进入下一次模型请求 | 3、5、6 |
| 2 三次停滞、变化重置 | 3、4、6 |
| 3 完整 checkpoint 恢复及共享预算 | 1、2、5、6 |
| 4 写入后无收据不重复 | 2、5、6 |
| 5 冻结定义、伪造标记、检查后变更 | 1、4、5、6 |
| 6 审批/限额/中断/期限/未结资源 | 1、3、5、6 |
| 7 有界反馈、引用、敏感内容隔离 | 2、3、5 |
| 8 前台 CLI/恢复/原后台单任务 | 6 |
| 9 外部改变使旧成功失效 | 4、5、6 |
| 10 两个提交不确定窗口 | 2、5、6 |

计划自检由主实现者完成：设计第一批均有任务承接；停止原因来自宿主；状态和方法名称统一；五项 Review Focus 均有归属；未把未来 DAG/daemon/自动补投并入本批。实现时发现必须改变这些公开契约或恢复保证，应先更新相应设计依据，不能用降低测试断言解决。

## 2026-10-25 完成交付记录

六项任务及各自修复的提交链（按执行顺序）：任务 1 `8715811 → f947771 → e03788e`；任务 2 `1f82a70 → 4b75b6b`；任务 3 `6b32ea3 → 16b5134 → fd227d5`；任务 4 `3e53eab → 6881420`；任务 5 `ebae9d6 → 3fadf55`；任务 6 `6a49eaf42f9c2139e547ab8b869cd02c53f2e110`。每项独立审查已完成。

[原整分支审查](../reviews/2026-10-23-artex-loop-controller-final-review.md)保留原始 **With fixes** 判定及全部 Declined-to-judge 内容。其唯一 F1 由 `76653f1eb9e53ab8d69dd22f1c807fc96be29e67` 修复；[2026-10-25 唯一局部复核](../reviews/2026-10-25-artex-loop-controller-final-fix-review.md)确认 **F1 ADDRESSED**，全部发现已处理，无新增问题。复核不把剩余验证限制改写成通过。

最终源码的完整串行全量为 331 文件、5375 通过、16 跳过，退出 0；并行全量仍有三个原 5000ms 超时，原因未证实。最终类型检查、构建与支持的固定 pnpm 包验收（24 场景）均退出 0；指定 npm 包入口曾被既有固定 pnpm 合同拒绝，不宣称通过。完整证据、包身份及能力边界见设计第八节和决策记录。本次仅文档收尾，未重复运行测试或构建，未 push、merge 或发布包。
