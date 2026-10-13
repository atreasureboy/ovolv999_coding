# 交互入口接入统一会话服务实施计划

> **For agentic workers:** Use superpowers:subagent-driven-development with disjoint file ownership and independent integration review.

**Goal:** 完成既有 T09 D 入口迁移，使 TTY、Ink 和仓库 ACP 协议实际通过 AgentService 执行与保存。

**Architecture:** AgentSessionClient 管理前端的会话绑定、历史视图、订阅和取消；AgentService 保持唯一运行与持久化责任。切换会话创建绑定目标目录的新 Engine，保留当前模型/权限配置，重新建立文件历史与费用归属。界面从持久事件更新消息和工具结果，原 observer 仅保留状态/诊断兼容。

**Tech Stack:** 现有 TypeScript、Node、Ink、Vitest；不新增依赖。

**Spec:** 2026-10-03-agent-core-roadmap.md T09 与 2026-10-08-agent-service.md D 切片，接续用户“下一批”的既有授权。

## 约束与审查重点

- 保留旧命令和 `--pipe`；不增加测试跳过或提高旧超时；不调用付费模型、不发布 npm。
- 完整历史与模型窗口分别修改；历史写入失败必须可见；旧会话不被新会话退出回调覆盖。
- 同名并行工具按 itemId 配对；事件回压和接收方关闭有界收敛；旧取消请求不能取消新回合。
- 失败会话切换保留原会话；恢复只显式创建保存历史的副本，不重放未知副作用或批准待办。
- ACP 仅声明仓库现有协议实际能力；真实命令通过同一配置装配，stdout 不能混入提示或 ANSI。

## 工作分配与接口

1. Root：新增 core/agentSessionClient.ts；AgentService 增加 getModelWindow/replaceModelWindow；Engine 在持久事件运行时关闭直接消息/工具回调；commands 的历史/续接接口支持 await；bin 接线与安装包验收。
2. TTY：cli/repl.ts、tasks.ts、ui/agentEventRenderer.ts 及对应测试；删除重复 deadline/save/trim 流程；计划模式使用独立会话服务并受取消控制。
3. Ink：在现有 ui/ink/inkRenderer.ts 内集中事件投影，调整 replController、runInkRepl、App、ToolCallView 及对应测试；按实际 itemId 投影，保留图片与模型设置功能。
4. ACP：integrations/acp.ts、acp/protocol.ts、acp/agentAdapter.ts、cli/acp.ts、cli/acpArgs.ts 及协议/真实客户端测试。

AgentSessionClient 构造参数为 engine、observer、cwd、可选 sessionDir/history/onEvent/deadlineMs/finalizationGraceMs。onEvent 可返回 Promise；runTurn 在终态事件投递后才完成。方法为 initialize、runTurn、replaceHistory、replaceModelWindow、switchSession、interrupt、steer、recover、dispose；同步 getHistory/getModelWindow 为服务的拷贝视图，engine/sessionDir/threadId/activeTurnId 为当前绑定的 getter。

## 验证与交付

- [x] 先观察入口没有持久事件、同名工具配错、完整历史被压缩覆盖、切换目录仍绑定旧资源等 RED。
- [x] 实现共享 client 与服务接口；以实际 Engine/本地 HTTP 验证保存、流式、会话切换、取消和显式恢复副本。
- [x] 三入口分别完成专项 GREEN；将确认缺陷交回所属实现者修复，由不同审查者复核。
- [x] 结果 artifact 按仍可读取的事件/最新快照保留；已退休且不被引用的结果可清理，未知文件不删除。
- [x] 全量类型/Lint/测试、构建、实际安装包和短时持续请求通过；提交、正常推送与远端核对结果另记 `.artifacts/agent-core/progress.md`。

TTY/Ink 的实时呈现复用原界面；本批不增加远程服务、标准 ACP 兼容认证或自动恢复未知副作用。恢复副本仍受现有工作区隔离约束，不能绕过未结束物理资源。
