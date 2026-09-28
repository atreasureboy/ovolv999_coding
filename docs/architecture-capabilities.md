# 工具与模块装配清单

核对入口：`src/tools/index.ts`、`src/core/engine.ts`、`bin/ovogogogo.ts`、`src/modules/`。以下描述实际装配关系，不把公开导出等同于默认启用。

## 工具

下表前七行中的所有工具均有实现、保留公开导出并由 `createTools()` 默认实例化。模型能否看到工具，还取决于有效角色工具清单、子 Agent 禁用清单、Plan Mode 和模块启用状态；能看到 schema 也不等于获得执行权限。

| 工具 | 默认注册 | 执行前提与限制 | 行为测试证据 |
| --- | --- | --- | --- |
| Read、Write、Edit、Glob、Grep、NotebookEdit | 是 | 写入受权限、读取快照、备份和工作区约束；子任务原生文件工具检查规范化真实路径 | `engineContract`、`fileEditAtomic`、`workspaceFileContainment`、`notebookEdit` |
| Bash、TmuxSession、ShellSession | 是 | 需要相应 shell/tmux；不确定 Bash 命令使用写锁；可写会话不作为并行只读工具 | `bashTool`、`worktreeCoordination`；真实 tmux 服务本轮未运行 |
| Agent、ClaudeCode | 是 | Agent 需要注入 factory；ClaudeCode 需要外部 CLI，未在本轮调用在线外部服务 | `agentFactory`、`agentOutcome`、`outcomePropagation`；不推断外部 CLI 可用 |
| TaskCreate、TaskGet、TaskList、TaskUpdate、TaskStop | 是 | 使用当前后台任务管理器；进程退出与任务验收状态分开 | `backgroundTaskManager`、`backgroundOutcome`、`backgroundSession` |
| TodoWrite、AskUserQuestion、ExitPlanMode、EnterPlanMode、VerifyPlanExecution、Sleep、Snip、Goal | 是 | 审批缺通道时明确需要输入；策略切换串行；验证按实际命令；上下文裁剪保留调用组 | `planTools`、`exitPlanMode`、`engineContract`、`sleep`、`snip`、`goals`；并非每种交互 UI 都做了人工验收 |
| EnterWorktree、ExitWorktree、ListWorktrees | 是 | 需要 Git；旧元数据缺基线时拒绝自动合并；只有当前产物对应的验收证据可接受 | `worktree`、`worktreeSafety`、`worktreeCoordination` |
| WebFetch、WebSearch、Diagnostics、ListMcpResources、ReadMcpResource | 是 | 网络、搜索后端、语言工具或已连接 MCP 服务分别是额外前提 | `webFetch`、`webSearch`、`diagnostics`、`mcpClient`、`mcpLifecycle`；网络测试不能等同于在线账号已连通 |
| Brief、CtxInspect、TerminalCapture、WebBrowser、PushNotification | 否 | 有实现、公开导出；本轮未发现默认 CLI 注入这五项。调用方可通过 `extraTools` 显式注入，未强制全部启用 | `newTools` 测试直接实例化及本地行为；不证明默认模型可见或外部通知已发送 |
| LoadSkill | 条件式 | CLI 发现可用 Skills 时通过 `extraTools` 注入 | 现有 skill 测试；依赖实际发现的技能 |
| MCP 动态工具 | 条件式 | 启用 mcp 模块且服务器连接、列工具成功后注册 | `mcpLifecycle`、`mcpClient` |

调度前检查重复工具名和 schema/handler 名称一致性。模块工具也通过同一 schema 校验；不可靠或可写元数据不会仅凭 `concurrencySafe: true` 获得只读并发。

## 模块

| 模块 | CLI 装配 | 生命周期与本轮证据 |
| --- | --- | --- |
| memory | 默认，除非项目显式改变 enabledModules | 每轮仍按任务检索；持久化与来源测试见 `persistenceLifecycle`、`persistenceMultiprocess` |
| workspace | 默认 | 随 sessionDir 提供工作区上下文；使用当前 Run 的工具上下文 |
| critic | 默认 | 使用共享模型入口；模型切换刷新；预算及取消在发送前检查 |
| reflection | 默认，依赖 memory | 保存真实终态及验证状态；失败经验不得转写为成功事实；与主 Run 共用取消域 |
| mcp | 配置服务器时默认加入，也可由 enabledModules 控制 | 同有效配置连接复用、single-flight、半初始化关闭、每轮工具刷新；本地 stdio 子进程生命周期测试 |

独立构造 Engine 时，默认模块由已有配置推导，并依赖调用方注册模块工厂。不能把 CLI 的注册行为套用到所有嵌入式调用。

当前默认 `McpClient` 只装配 stdio。HTTP/SSE MCP 未接入该入口，明确拒绝不支持的 transport。独立 OAuth 工具与测试的存在不表示 MCP HTTP/OAuth 已默认启用。本轮未运行任何线上 MCP、OAuth 登录或通知发送。
