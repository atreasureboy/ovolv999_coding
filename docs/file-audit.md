# 逐文件审查与修复

本轮从 `6b61b5c5eb3bd079fbab46e513edab76f434cab9` 开始，按用户要求实际读取实现、复现缺陷、修复并验证。仍使用 TypeScript strict、ESM 和现有公开入口，保留健康历史数据。没有为追求文件数而机械改写，也没有把本地测试通过等同于线上能力或全部输入无缺陷。

## 覆盖记录

[逐文件清单](file-audit-ledger.json) 收录运行源码、构建与交付实现、测试与项目资料。每个实现文件有读取结论，确认问题附有回归依据。SHA256 使用 UTF-8 文本并将 CRLF 统一为 LF。

运行源码及交付实现共 **260 个文件，已全文读取**。内部测试文件由对应模块审查；历史 `tests/` 文件纳入全量执行，并复核变更涉及的用例，未声明所有历史测试均人工逐行审查。生成的依赖锁通过冻结安装验证。旧整改记录保留原批次日期、提交和失败结果，不覆盖成当前成功结果。

`loop-kit/`、`.opencode/skills/` 和 `goal.md` 是历史任务模板及外部工具参考，不属于产品运行源码；未执行其中循环、自动化或权限指令。PowerShell 参考脚本只读语法解析通过。审查计划、此报告、状态文件和清单自身不参与清单自哈希。

## 实际修复

| 范围 | 原问题及结果 | 回归入口 |
| --- | --- | --- |
| 配置与辅助存储 | 项目缺省值覆盖全局配置、损坏但可解析 JSON 导致崩溃或丢失健康行、原型键误查、跨工作区缓存污染；按字段和行校验，隔离缓存，保持健康旧数据兼容。 | `tests/core/persistedUtilitiesAudit.test.ts`、`auxiliaryStoresAudit.test.ts`、`runtimeEnumAudit.test.ts` |
| 引擎与验收 | 流超时误作用户取消、模块启动异常、验证后的产物和资源边界；保留真实 failed/cancelled/blocked 区别，未结算资源不能获得成功状态。 | `tests/core/engine/timeoutOutcome.test.ts`、`runtimeConfigAudit.test.ts`、`loopWorkspaceAudit.test.ts` |
| 进程与任务 | 取消过程中 root close 被当作树终止、正常退出后仍有已记录后代、Windows 带空格执行路径失败；按 PID 与出生身份累积树，实际停止并确认已知后代，未知状态保留资源占用。 | `tests/core/execManagedOrphan.test.ts`、`backgroundTaskOrphan.test.ts`、`backgroundShellInvocation.test.ts` |
| 文件、搜索、笔记本与技能 | 忽略注入工作区、路径和索引边界、技能存取目录不一致、字面参数被替换语法解释；修复真实工具处理器，旧技能仍可读取。 | `tests/tools/`、`tests/skills/loader.test.ts`、`tests/notebookEdit.test.ts` |
| 网络与协议 | 超时未覆盖响应 body、UTF-8 分块损坏、MCP 服务错误误作空结果、OAuth/LSP/daemon 启停和帧边界不完整；补整个操作期限、连续解码和明确错误。 | `tests/core/oauthLifecycleAudit.test.ts`、`lspBehaviorAudit.test.ts`、`daemonLifecycleAudit.test.ts`、`mcpAuditErrors.test.ts` |
| 终端与命令 | 命令读取旧历史或错误工作区、Ink ESC 和搜索 overlay 输入冲突、工作流递归、blocked 显示 Done、退出遗留会话 writer；修复实际处理器和输入/退出路径。 | `tests/commands/`、`tests/cli/replLifecycle.test.ts`、`tests/ui/ink/` |
| 权限与诊断 | 执行脚本被判只读、sandbox 开关宣称实际未接入的隔离、Node 最低版本和安装诊断失真；按实际执行能力输出并使用真实审批边界。 | `tests/core/contractsAudit.test.ts`、`sandboxBoundaries.test.ts`、`tests/utils/systemHealthBoundaries.test.ts` |
| 安装与交付 | 两套安装脚本漂移、Windows 入口解析错误、构建失败仍继续、按块解码命令输出；统一共享安装流程，冻结依赖、构建、失败中断，保留已有环境配置。 | `tests/setupScripts.test.mjs`、`tests/releaseUtils.test.mjs`、`scripts/package-smoke.mjs` |

此外修复 Git 设置同步的重复推送和临时目录冲突、团队记忆提交参数、SSH 参数转义、代码指标大文件溢出、文档章节重复、onboarding 检测、goal 更新和 cron 闰日/范围边界。共享行为只在契约相同处抽出；同步辅助存储没有被宣称为多进程事务存储。

本机可复现的确认缺陷使用失败回归约束修复；平台之外的代码检查单列为未原生验证。保留已有要求，TSX 用例进入类型检查；纯 ESM JS 测试使用适合 JS 的 lint 规则，TS/TSX 的类型规则未放宽。原有进程、工作区所有权和验证要求保持。

## 验证

基线类型检查和 lint 通过；193 个测试文件、3814 项通过，14 项跳过。当前 Windows 主机使用 Node `v24.20.0`、pnpm `11.25.0`。

冻结后的整仓类型检查、lint 和构建通过。全量测试 **254 个文件、4180 项通过、14 项跳过**，耗时 66.22 秒；本轮没有增加 Windows 跳过项。验证前后 535 个源码/测试/验证输入的指纹一致：`60ef62ead1e422414cfafb28add89784017480b0564319f169919f1b0d0a73ee`。

首次整仓运行发现两个测试环境问题，原日志保留：旧 cron 子进程测试单文件转译后找不到新共享依赖，本地 OAuth 测试随机分配到请求库拒绝的端口。已补齐真实测试依赖并选择高位空闲端口，保留两秒防卡死边界，并收紧 body timeout 断言；上述数字来自修复后的完整重验。

锁定依赖安装、Git Bash 对两个 shell 入口的语法检查和 diff 检查通过。当前构建的源码指纹为 `79480d0a10774f5466dc999d2e40b063a9c5f5911191c777e562ce40e7c00ff4`；提交前本地构建明确标记 dirty，独立安装后的干净候选验收和短时稳定性结果另行记录。日志位于忽略目录 `.artifacts/file-audit/`；安装包和短时稳定性证据位于 `.artifacts/production/`。

## 能力边界

当前后端为 `trusted-local`，没有内核级进程容器。修复可以确认并停止运行期间已捕获出生身份的后代；如果 root 在任何身份/关系捕获前极快退出，无法一般性证明所有未知后代均已终止。这一边界未通过给 fixture 增加等待或让所有短命令报失败来掩盖。请求 `isolated-worker` 仍明确失败。

原一般性保证探针已实测反例：未等待管理器捕获关系，root 正常退出，任务为 completed、scope pending 为 0，但测试独立观察的 detached leaf 仍以相同出生身份存活。原 RED 和最终反例保留在 `.artifacts/file-audit/background-task-orphan-final-boundary.txt`，未宣称该一般性保证已修复。常规回归按实际支持的“已观测进程”契约检查：任务结果明确 `processAccounting: observed-only` 和限制说明；原 fixture 和退出时序保持，已记录后代的实际终止断言保持。没有跳过此探针，也不盲杀测试侧回填的未知 PID。提供任意后代的终止保证需要另行实现并验证内核级 containment。

SSH、tmux、系统通知与在线服务涉及本机之外或可选外部工具，本轮参数/协议及本地 fixture 验证不证明真实服务成功。OAuth 使用真实 loopback HTTP 验证，没有使用真实用户令牌登录。LSP 使用 mock stdio 协议 fixture，本机未验证真实 LSP 子进程或服务；TypeScript 的 tsserver 不能直接当作 LSP server，发现逻辑改用可选的 [typescript-language-server](https://github.com/typescript-language-server/typescript-language-server)，协议依据见 [TypeScript 官方说明](https://github.com/microsoft/TypeScript/wiki/Standalone-Server-%28tsserver%29)。

本地 Windows 结果不证明 Linux/macOS 已通过；CI 矩阵配置也不等于远端作业结果。短时 MCP 稳定性验证不代替四小时候选验证、旧二进制降级演练或完整外部服务验证。具体安装包支持与回退要求见 [交付说明](release-support.md)。
