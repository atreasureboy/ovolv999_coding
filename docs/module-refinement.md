# 逐模块精简与职责边界

历史记录：2026-10-03 的模块重构批次，基线 `d6e3e9c`，先于当前逐文件审查。本文规模和验证数字保持该批次原始结果；后续修复与验证见 [逐文件报告](file-audit.md)。

本轮以 `d6e3e9c` 为基线，保持 TypeScript、ESM、现有模型协议及历史数据兼容。实现按职责拆分、合并重复步骤，并修复测试能复现的问题。参考官方 Codex 的工具路由、审批和 turn 生命周期边界，具体来源见 [设计记录](superpowers/specs/2026-10-03-module-refinement-design.md)。这不是功能对等声明。

## 现在从哪里读代码

| 入口 | 负责什么 | 细节所在位置 |
| --- | --- | --- |
| `bin/ovogogogo.ts` | CLI 装配、运行模式和最终清理 | `src/cli/`：参数、环境、路径、审批、会话子命令、单任务、交互会话 |
| `src/core/engine.ts` | 一轮执行的状态推进、模块及工具调度 | `core/engine/`：observer、toolPolicy、responseStream、toolResults、acceptance |
| `src/commands/builtin.ts` | 按既有顺序注册有效命令 | 九个 `*Commands.ts` 分别承载会话、转录、配置、工作区、自动化、知识、资源、诊断和集成命令 |
| `src/ui/ink/runInkRepl.ts` | 渲染装配与退出 | `replController.ts` 管会话历史与动作；`store.ts` 发布展示状态 |
| `src/tools/fileRead.ts`、`fileWrite.ts`、`fileEdit.ts` | 各工具的业务规则和失败边界 | `fileOperations.ts` 共用路径、备份、取消及原子保存；`fileEditFormatting.ts` 管格式化及差异展示 |
| `src/tools/bash.ts` | 进程执行、取消和实际结算 | `boundedOutput.ts` 只管理有界头尾输出 |
| `src/core/compact.ts` | 保留消息组、裁剪和模型摘要 | `compact/budget.ts` 管上下文预算；`tokens.ts` 管估算 |
| `src/core/providers.ts` | 保持原公开导出 | `providers/registry.ts` 元数据，`detection.ts` 识别与能力，`types.ts` 契约 |
| `src/config/settings.ts` | 读取与持久化设置 | `settings/normalization.ts` 校验，`merge.ts` 区分分层追加和补丁替换 |
| `src/integrations/acp.ts` | 请求调度与执行所有权 | `acp/protocol.ts` 方法规则及错误，`framing.ts` UTF-8 输入组帧 |
| `src/core/sessionManager.ts`、`runStore.ts` | 对话和运行状态的兼容持久化 | 共享有索引的消息校验、命名的 schema 校验；保留原版本和写入顺序 |
| `src/core/backgroundTaskManager.ts` | 后台任务生命周期 | 统一终态元数据赋值，实际进程结算和停止失败仍分别处理 |
| `src/modules/reflection.ts` | 基于真实结果整理经验 | 统一模型 JSON 请求、解析和确认持久化的步骤 |
| `src/core/semanticMemory.ts`、`costTracker.ts` | 记忆索引与来源排序、用量和成本 | Map 隔离用户字符串键；两条成本路径共享单一算价函数 |

引擎只依赖核心定义的 `EngineObserver`，终端 Renderer 按这个接口提供显示能力。模块 boot 结果属于当前 turn，不再存放于跨 turn 的实例字段。工具的模型可见规则和实际执行规则共用策略；当前 plan 状态仍在执行前检查。

结果验收维持原顺序：工具失败和取消归并、产物检查、执行验证、模块收尾、再次检查产物、记录终态。模块收尾后修改产物会使旧验收失效；未结算资源不能获得 completed。

## 精简和修复的依据

- 删除被后续注册覆盖的 `/export`、`/plugins`、旧 `/snip` 实现。有效别名与公开命令列表保留，其中 `/snip` 仍指向 `/snippet`。没有因“看起来不像 Codex”而删除仍在使用的命令。
- 合并流请求重试的构造和用量记录，修复空工具集合重试时仍带工具参数的问题。自动压缩的两条入口都有真实请求取消测试，替代读取源码文本的检查。
- 终端退出或输入异常都会解绑监听器、清理 prompt；临时规划引擎会释放。恢复会话后，对话自动保存和 slash 上下文跟随当前会话目录。
- Ink 完成任务后的命令使用最新历史，命令产生的任务也保留在会话中。状态发布避免修改已经交付给订阅者的流消息快照。
- 保留文件工具中 stale-read、权限、备份、abort、原子写和缓存更新的顺序；不把它们合成一个隐藏所有业务规则的大函数。
- 修复 Git index/working tree 状态混淆，以及带空格的改名路径处理。项目分支缓存按工作目录隔离；图片尺寸优先读取真实文件头，元数据命令使用参数数组。
- 记忆标签、未知来源和未知模型名称可以是 `constructor`、`__proto__`、`toString` 等字面字符串，不再读取对象原型或污染成本累计。
- cron 的数值和名称解析、步长校验分别有单一入口，拒绝导致死循环的零步长并支持 `MON-FRI`。LSP 按 UTF-8 字节组帧，重启时清空旧帧，旧进程事件不影响新请求。
- MagicDocs 合并两条依赖收集路径，无原型字典保留既有数字键排序。Onboarding 的平铺及递归目录共用 500 文件预算。NotebookEdit 删除经过前置校验后不可达的 replace-to-insert 分支。

## 已检查并保留的边界

`ModuleRegistry` 的依赖 DFS 已足够集中，补充菱形依赖用例后保留实现。Workspace、Critic、Memory 和 MCP 模块的生命周期各有职责；MCP 半初始化、复用和关闭逻辑不再另套一层管理器。EpisodicMemory 保留独立的同步追加、异步租约和保留上限语义。

ModelGateway、ProviderAdmission、RunContext、执行后端、工作区租约、恢复状态和进程身份继续使用既有协议。普通文件工具的异步原子写与会话/记忆的同步持久化不强行合并，因为权限、模式保留和确认写入的契约不同。

没有逐文件机械改写整个仓库。小工具、展示组件和纯算法只有在能证明重复责任或错误时才调整。外部 SSH、tmux、真实在线模型、OAuth 及线上 MCP 不由本地回归测试证明可用。

## 规模

按非测试 `.ts/.tsx` 文件统计，修改 33 个既有源码文件，新增 41 个职责模块；总源码行数 57,707 → 56,878。行数包含注释，入口缩短也包含代码迁移，因此不能把这些数字当作性能提升或功能覆盖率。

| 入口 | 基线行数 | 重构后行数 |
| --- | ---: | ---: |
| CLI 入口 | 1958 | 616 |
| Engine | 1878 | 1204 |
| Builtin 注册入口 | 3318 | 123 |
| Compact 策略入口 | 825 | 435 |
| Providers 兼容入口 | 483 | 58 |
| Settings 读取保存入口 | 256 | 57 |
| ACP 请求调度 | 361 | 218 |
| Ink 渲染入口 | 233 | 47 |

## 验证

基线：类型检查与 lint 通过，172 个测试文件通过，3672 项通过、14 项跳过。

冻结后的完整类型检查和 lint 通过。193 个测试文件通过，3814 项通过、14 项跳过；完整回归耗时 54.68 秒，包含 Windows 真实进程和多进程持久化验证。没有新增跳过项。

独立交叉审查未发现重构引入的实质回归。额外差分检查覆盖 13,125 次 Bash 字节缓冲操作、374 个 RunStore JSON 边界、500 个混合历史裁剪场景和 63 个合法 cron 字段，与基线行为相同；这不等同于所有输入的形式证明。

干净构建、打包、独立目录冻结安装及安装后验收通过，共 18 项检查：包括命令 shim、help/version、ESM 命令加载、单任务/管道/stdin、历史恢复、审批拒绝、编辑后真实验证、旧 schema、ACP stdio 和后台进程树停止。验收使用本地模型服务，未访问线上模型。

安装验收对应 clean commit `0fac35c0f267b99d704f9527fd84127ad7509dc5`，源码指纹 `fa332049dd3a93487d415c044dc0eab6e778b84380112c49207af09f36d502f5`；后续仅完善文档，最终 clean build 指纹相同。npm 包 SHA256：`28aa246aabdb50bd03f134e2625d15faf6a6c585eb84f3fa0386c21f8b19c36d`。

最终编译入口实测：`createTools()` 默认实例化 32 个工具；命令组定义 82 个有效主命令，注册后含别名共 136 个条目。模块工具、动态 MCP 和按需 LoadSkill 在运行时另行装配。

回归日志位于忽略目录 `.artifacts/refactor/`；打包验收日志位于 `.artifacts/production/release-package-smoke.json`。这两个目录不进入 npm 包。
