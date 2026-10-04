# OVO 与 Codex CLI / Claude Code 的代码差距及整改规格

核对日期：2026-10-03。OVO 基线：`44324598ad01be40b820848651f38d54c17cc2e9`，仓库 `atreasureboy/ovolv999_coding`。本次检查入口与实际调用链，没有修改实现、重跑完整测试或执行下述计划。证据链接固定在这个提交，后续修复不能直接沿用旧结论。

后续实际修改及重新验证另见 [Agent 核心整改进度](agent-core-progress.md)；下表保留上述基线快照，不作为当前实现状态。

结论：项目已经具备可工作的 agent 循环，以及权限、压缩、会话、后台任务、工作树、模块和 MCP 的基础。当前距离成熟终端 coding agent 的主要差距，是若干公开功能没有贯通真实执行链，模型与工具缺少统一的能力契约，执行隔离、恢复和交互协议尚不完整，以及没有真实编码任务的效果基线。继续增加工具名称或提示词，不能替代这些工作。

## 比较边界与判断方法

比较对象是本地 Codex CLI 和 Claude Code 终端工作流；Desktop、云任务、团队管理和商业连接器生态不作为本轮必做目标。Codex 的公开源码固定为 [`b741e480e203f037ca726bc2a76d99a8e8668e66`](https://github.com/openai/codex/tree/b741e480e203f037ca726bc2a76d99a8e8668e66)，只读取相关源文件，没有运行或移植其代码。Claude Code 按官方文档确认可观察行为，不推测其闭源内部算法。

“缺失”指实际入口没有该能力；“部分”指实现存在但边界或接入不完整；“未验收”指源码/模拟测试不能证明真实环境兼容；“改进项”指本项目可改进，但没有证据证明对手采用了某种内部方案。静态缺陷和需要运行验证的风险分开描述。没有同模型、同任务、同预算的对照数据，因此不提供“达到对手多少百分比”、成功率或性能排名。

优先级：P0 为执行边界与数据保全；P1 为功能真实性和核心编码闭环；P2 为扩展兼容与成熟度；P3 为经过效果证据支持的进一步优化。P0/P1 的排序还要考虑依赖，编号不是工期顺序。

## 已有能力，禁止当作缺失重新实现

- 引擎已具备流式工具循环、取消、请求超时、限流重试、部分流不重放、后台资源保留和工作区隔离锁。
- 历史压缩、微压缩、上下文溢出恢复、会话原子写入与所有权检查已存在；持久文件备份与基线撤销已存在。
- 计划模式、工具权限与子代理工具限制已存在。普通 CLI 未配置旧 `auto` 模式时，权限管理器走 `default`，不能据另一个字段的 `auto` 回退值认定默认全面绕过权限。
- 工作树合并已检查提交产物、执行过的验收、产物版本、目标未移动、干净状态和快进合并；不能为了“简化”恢复强制清理。
- MCP 本地工具调用、技能索引与按需加载、图片输入和若干 LSP 客户端操作已存在。

上一轮记录的 254 个测试文件、4180 个通过案例、14 个原有跳过案例，是对应提交的回归证据；不证明任务解题质量，也不是本次重新运行的结果。此前真实后台进程测试已明确揭示未观测脱离后代的边界；本次不把降低断言后的通过误报为完整进程包含。

## 逐项差距

| ID | 项目与分类 | 当前代码事实及影响 | 优先级 / 计划任务 |
| --- | --- | --- | --- |
| G01 | 执行沙箱：缺失 | [`executionBackend.ts:33`](https://github.com/atreasureboy/ovolv999_coding/blob/44324598ad01be40b820848651f38d54c17cc2e9/src/core/executionBackend.ts#L33) 对所有平台拒绝 `isolated-worker`，其余直接启动宿主进程；工作目录不是文件系统/网络边界。现有容量限制只数受管理根进程，没有 CPU/内存/后代配额。 | P0 / T02–T04 |
| G02 | 物理进程归属和退出：部分 | [`backgroundTaskManager.ts:642`](https://github.com/atreasureboy/ovolv999_coding/blob/44324598ad01be40b820848651f38d54c17cc2e9/src/core/backgroundTaskManager.ts#L642) 明示 `observed-only`；快脱离后代可能在首个快照前失去关系。前台 Bash、MCP、hooks 又没有统一采用 managed exec 的身份跟踪退出语义。 | P0 / T03 |
| G03 | 凭据环境与执行策略接入：部分 | [`executionBackend.ts:47`](https://github.com/atreasureboy/ovolv999_coding/blob/44324598ad01be40b820848651f38d54c17cc2e9/src/core/executionBackend.ts#L47) 默认继承环境；CLI 不传 profile，MCP 配置归一化丢弃 profile/limits。实际 [`hooks.ts:98`](https://github.com/atreasureboy/ovolv999_coding/blob/44324598ad01be40b820848651f38d54c17cc2e9/src/config/hooks.ts#L98) 直接同步执行并继承环境。错误脱敏不等于子进程拿不到密钥。 | P0 / T02、T16 |
| G04 | 崩溃恢复：部分 | [`runStore.ts:114`](https://github.com/atreasureboy/ovolv999_coding/blob/44324598ad01be40b820848651f38d54c17cc2e9/src/core/runStore.ts#L114) 只保留操作名、只读标记、时间和收据状态，缺少请求摘要、资源、前后产物和幂等信息。恢复能保守隔离，但不能重建确切待办操作。 | P0 / T07 |
| G05 | 审批渠道、范围与并发：部分 | 工具审批仅接 Ink：[`ovogogogo.ts:422`](https://github.com/atreasureboy/ovolv999_coding/blob/44324598ad01be40b820848651f38d54c17cc2e9/bin/ovogogogo.ts#L422)。Always 授予整个 `Tool(*)`，预览只显示 100 字符；[`store.ts:287`](https://github.com/atreasureboy/ovolv999_coding/blob/44324598ad01be40b820848651f38d54c17cc2e9/src/ui/ink/store.ts#L287) 新请求会否决之前的待审批请求。风险分类是词法启发式，不能代替隔离。 | P1 / T08 |
| G06 | 原生模型协议与能力协商：缺失 | [`modelGateway.ts:55`](https://github.com/atreasureboy/ovolv999_coding/blob/44324598ad01be40b820848651f38d54c17cc2e9/src/core/modelGateway.ts#L55) 只代理 Chat Completions；[`engine.ts:360`](https://github.com/atreasureboy/ovolv999_coding/blob/44324598ad01be40b820848651f38d54c17cc2e9/src/core/engine.ts#L360) 统一用 OpenAI 消息结构。Anthropic/Google 目录只是元数据，不能当作原生接口支持。 | P1 / T05 |
| G07 | 推理档位：未接入 | [`configurationCommands.ts:371`](https://github.com/atreasureboy/ovolv999_coding/blob/44324598ad01be40b820848651f38d54c17cc2e9/src/commands/configurationCommands.ts#L371) 只改全局状态并显示 Prompt；引擎、系统提示构造和请求均未消费。显示的 thinking/search/verification 档位不改变下一次执行。 | P1 / T05 |
| G08 | 费用、缓存和调用统计：部分 | [`engine.ts:406`](https://github.com/atreasureboy/ovolv999_coding/blob/44324598ad01be40b820848651f38d54c17cc2e9/src/core/engine.ts#L406) 只累计该引擎主请求；压缩、critic、reflection 和子代理未汇入父展示。[`costTracker.ts:79`](https://github.com/atreasureboy/ovolv999_coding/blob/44324598ad01be40b820848651f38d54c17cc2e9/src/core/costTracker.ts#L79) 无缓存/推理类别；cache-stats 记录函数没有真实请求调用者。已有 run-family admission 不能据此认定也失效。 | P1 / T06 |
| G09 | 上下文容量与估算：未验收 | [`compact/tokens.ts:3`](https://github.com/atreasureboy/ovolv999_coding/blob/44324598ad01be40b820848651f38d54c17cc2e9/src/core/compact/tokens.ts#L3) 固定字符比例，图片固定 1024；目录、正则和 unknown 回退给窗口值。估算用于硬准入，但没有跨模型/语言/图像的误差证据。 | P1 / T10 |
| G10 | 压缩后的任务保真：部分，含明确缺陷 | [`compact.ts:174`](https://github.com/atreasureboy/ovolv999_coding/blob/44324598ad01be40b820848651f38d54c17cc2e9/src/core/compact.ts#L174) 只串行化字符串正文；旧图文数组消息连文字要求也未送入摘要。工具参数只取 200 字符。最近消息保留已存在；不能错误声称全部工具输出只取 500 字符。 | P1 / T10 |
| G11 | 独立工作树子代理并发：部分 | [`agent.ts:138`](https://github.com/atreasureboy/ovolv999_coding/blob/44324598ad01be40b820848651f38d54c17cc2e9/src/tools/agent.ts#L138) 禁用并发；[`toolPolicy.ts:42`](https://github.com/atreasureboy/ovolv999_coding/blob/44324598ad01be40b820848651f38d54c17cc2e9/src/core/engine/toolPolicy.ts#L42) 把调用拆为顺序批次。已有按工作区队列，却没有让不同工作树同时工作。 | P1 / T12 |
| G12 | 原生子代理续接：缺失 | [`agent.ts:335`](https://github.com/atreasureboy/ovolv999_coding/blob/44324598ad01be40b820848651f38d54c17cc2e9/src/tools/agent.ts#L335) 清空 sessionDir，`:448` 以空历史启动，结束后释放，结果不返回可继续的 agentId。外部 Claude/tmux worker 有 send/wait，不能混作原生 Agent 的实现。 | P2 / T12 |
| G13 | 客户端协议与中途引导：部分 | [`eventLog.ts:38`](https://github.com/atreasureboy/ovolv999_coding/blob/44324598ad01be40b820848651f38d54c17cc2e9/src/core/eventLog.ts#L38) 是审计日志，没有统一 thread/turn/item 生命周期与重连游标。[`acp.ts:40`](https://github.com/atreasureboy/ovolv999_coding/blob/44324598ad01be40b820848651f38d54c17cc2e9/src/integrations/acp.ts#L40) 声明不流式，且无正式 CLI/engine 接线；取消存在，运行中输入没有带 turnId 校验的 steer 契约。 | P1 / T09 |
| G14 | 无界面编码执行：部分 | [`ovogogogo.ts:111`](https://github.com/atreasureboy/ovolv999_coding/blob/44324598ad01be40b820848651f38d54c17cc2e9/bin/ovogogogo.ts#L111) 的 `--pipe` 是一次无工具回答；正常单任务用引擎但输出面向人。没有贯穿真实编辑/测试的 JSONL、最终 schema、审批宿主和续接契约。 | P1 / T09 |
| G15 | MCP 协议覆盖：部分 | [`mcpClient.ts:104`](https://github.com/atreasureboy/ovolv999_coding/blob/44324598ad01be40b820848651f38d54c17cc2e9/src/core/mcpClient.ts#L104) 拒绝非 stdio；初始化要求版本完全相同，列表只取一页，忽略服务端通知/主动请求。不能宣称支持托管 HTTP 服务、动态目录或完整交互。 | P2 / T15 |
| G16 | MCP 资源入口：未接入 | [`mcpResources.ts:20`](https://github.com/atreasureboy/ovolv999_coding/blob/44324598ad01be40b820848651f38d54c17cc2e9/src/tools/mcpResources.ts#L20) 读未声明的 `ctx.mcpRegistry`，实际模块没有写入；因此工具调用可用时，资源入口仍报告没有服务器。现有相关测试手工注入注册表。 | P1 / T14 |
| G17 | 技能执行语义：部分 | [`loader.ts:32`](https://github.com/atreasureboy/ovolv999_coding/blob/44324598ad01be40b820848651f38d54c17cc2e9/src/skills/loader.ts#L32) 只表示基础字段，展开仅 `$ARGS`。声明 `tools` 只检查工具存在，不构成工具限制；较丰富的触发、fork/model/hooks 控制没有支持或不支持诊断。 | P1 / T13 |
| G18 | CLI / Ink 功能一致性：部分 | 普通 REPL 注入 [`repl.ts:424`](https://github.com/atreasureboy/ovolv999_coding/blob/44324598ad01be40b820848651f38d54c17cc2e9/src/cli/repl.ts#L424) 的技能解析；Ink 只收名称和说明，缺少解析回调，自动补全可见的技能落为字面输入。UserPromptSubmit hook 也未走同一路径。 | P1 / T13、T16 |
| G19 | Hooks 配置与真实执行：未贯通 | [`integrationsCommands.ts:10`](https://github.com/atreasureboy/ovolv999_coding/blob/44324598ad01be40b820848651f38d54c17cc2e9/src/commands/integrationsCommands.ts#L10) 管理 core/hooks 的 hooks.json；CLI 实际实例化另一套 settings.hooks runner。[`engine.ts:570`](https://github.com/atreasureboy/ovolv999_coding/blob/44324598ad01be40b820848651f38d54c17cc2e9/src/core/engine.ts#L570) 不使用 pre-hook 返回结果。不能把 `/hooks` 中的阻断当成已执行的安全策略。 | P1 / T16 |
| G20 | 插件启用：未贯通 | [`pluginManager.ts:227`](https://github.com/atreasureboy/ovolv999_coding/blob/44324598ad01be40b820848651f38d54c17cc2e9/src/core/pluginManager.ts#L227) 只改注册信息；另一套 plugins 实现只检查文件，没有生产 bootstrap 导入贡献组件。Enabled 不代表 tools/skills/hooks/MCP 已可用。远程安装明确未实现。 | P2 / T17 |
| G21 | 语言智能：部分、未验收 | [`lspClient.ts:159`](https://github.com/atreasureboy/ovolv999_coding/blob/44324598ad01be40b820848651f38d54c17cc2e9/src/core/lspClient.ts#L159) 有客户端能力，但真实使用只到 `/lsp status|symbols`；文件编辑未自动同步，引擎无可调用定义/引用/hover。[`lspBehaviorAudit.test.ts:8`](https://github.com/atreasureboy/ovolv999_coding/blob/44324598ad01be40b820848651f38d54c17cc2e9/tests/core/lspBehaviorAudit.test.ts#L8) 模拟进程，不能证明真实语言服务验收。 | P2 / T18 |
| G22 | 路径范围指令：部分 | [`ovogomd.ts:89`](https://github.com/atreasureboy/ovolv999_coding/blob/44324598ad01be40b820848651f38d54c17cc2e9/src/config/ovogomd.ts#L89) 已支持 root→启动 cwd 和 AGENTS.md；启动于根目录后操作更深子树，不会加载该子树规则。另有未接入的 CLAUDE-compatible prompt 工具。 | P1 / T13 |
| G23 | 回合检查点与撤销：部分 | [`workspaceCommands.ts:11`](https://github.com/atreasureboy/ovolv999_coding/blob/44324598ad01be40b820848651f38d54c17cc2e9/src/commands/workspaceCommands.ts#L11) 的 rewind 只列表；undo 恢复文件的会话基线。会话消息和文件版本没有回合对应关系，无法选择代码/对话/两者恢复。 | P2 / T19 |
| G24 | 真实任务效果基线：缺失 | [`package.json:29`](https://github.com/atreasureboy/ovolv999_coding/blob/44324598ad01be40b820848651f38d54c17cc2e9/package.json#L29) 和 [`release-gate.mjs:12`](https://github.com/atreasureboy/ovolv999_coding/blob/44324598ad01be40b820848651f38d54c17cc2e9/scripts/release-gate.mjs#L12) 是回归、构建、包和稳定性检查。没有固定真实仓库任务的解题成功率、误改、时间、token、人工介入与对照运行。artifact-scan-bench 是扫描微基准，不是 coding eval。 | P1 / T01 |
| G25 | 真实环境发布资格：未验收 | 本地包 smoke、短期 MCP soak 和 CI 矩阵已有，但真实模型、真实 LSP、SSH/tmux、在线认证 MCP、原生通知等不能从模拟测试推定通过。[`release-support.md`](https://github.com/atreasureboy/ovolv999_coding/blob/44324598ad01be40b820848651f38d54c17cc2e9/docs/release-support.md) 应持续绑定运行证据，配置 CI 不等于 CI 实际成功。 | P2 / T21 |
| G26 | 记忆规则更新：改进项 | [`semanticMemory.ts:183`](https://github.com/atreasureboy/ovolv999_coding/blob/44324598ad01be40b820848651f38d54c17cc2e9/src/core/semanticMemory.ts#L183) 来源优先级只处理相同内容哈希；相反内容会并存。旧高置信规则可与新更正一起进入上下文。保留词法检索，不推定对手使用向量或某种冲突算法。 | P2 / T11 |
| G27 | 终端会话统一与原生平台支持：部分 | [`tmuxSession.ts:59`](https://github.com/atreasureboy/ovolv999_coding/blob/44324598ad01be40b820848651f38d54c17cc2e9/src/tools/tmuxSession.ts#L59) 已能 new/send/keys/capture/wait/kill，ShellSession 也有持久远程 exec；不能说没有交互终端。缺口是共同的 run/权限/物理归属/输出游标，以及已验收的原生跨平台 PTY/ConPTY 契约。Bash follow 仅是观众窗口。 | P2 / T20 |
| G28 | 工作树生命周期持久化：部分 | [`worktree.ts:69`](https://github.com/atreasureboy/ovolv999_coding/blob/44324598ad01be40b820848651f38d54c17cc2e9/src/tools/worktree.ts#L69) 的验收证据在内存；`:116` 元数据普通写入并吞掉失败。重启后需要重新验收，元数据遗失时没有和实际 git worktree 列表恢复对账。安全合并检查本身已存在。 | P1 / T07 |

## 对标依据与合理目标

1. **执行边界。** Codex 明确区分沙箱权限与审批，并有 macOS/Linux/Windows 执行实现；Claude Code 文档说明支持平台的文件系统和网络隔离。目标是让 OVO 每种执行模式可验证地兑现边界；不能要求所有平台都假装支持，也不能声称对手保证任意外部副作用可回滚。[Codex 审批与隔离](https://learn.chatgpt.com/docs/agent-approvals-security)、[Claude Code 沙箱](https://code.claude.com/docs/en/sandboxing)。
2. **模型契约。** Codex 源码具有 Responses 请求、回合级推理控制和用量类别。OVO 不必复制其 Rust 架构、私有请求头或默认模型，应该让自己的 provider adapter 与能力声明一致。[Codex 模型客户端](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/src/client.rs#L11)、[回合参数](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L245)、[用量结构](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/protocol/src/protocol.rs#L2241)。
3. **可集成的 agent。** Codex 官方提供 thread/turn/item、审批、流事件、steer 和非交互结构化输出；Claude Code 的程序入口沿用工具循环与上下文，并提供流式输出。目标是 OVO 的 CLI、Ink 和客户端入口共享真正的 coding loop，避免独立的弱化路径。[Codex App Server](https://learn.chatgpt.com/docs/app-server)、[Codex 非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)、[Claude Code 程序入口](https://code.claude.com/docs/en/headless)。
4. **扩展可实际使用。** Claude Code 的技能、hooks、插件和 MCP 文档描述具体运行语义，MCP 可按需发现工具。目标首先是把 OVO 已有入口接通，再按本项目支持范围扩展；不导入不理解的 frontmatter，也不把技能的 permission grant 错当作工具限制。[技能](https://code.claude.com/docs/en/skills)、[Hooks](https://code.claude.com/docs/en/hooks)、[插件](https://code.claude.com/docs/en/plugins)、[MCP](https://code.claude.com/docs/en/mcp)。
5. **长任务与恢复。** Claude Code 文档支持子代理继续工作、持久回合检查点与选择代码/对话恢复，也明确 shell 改动和外部副作用等限制。Codex 的 AGENTS.md 支持分层启动指令。路径运行时规则刷新是本项目明确选定的加强目标，不把 Codex 的“每次启动构造指令链”误说成动态扫描所有编辑路径。[子代理](https://code.claude.com/docs/en/sub-agents)、[检查点](https://code.claude.com/docs/en/checkpointing)、[Codex 指令链](https://learn.chatgpt.com/docs/agent-configuration/agents-md)。

G04、G26、G28 和资源硬配额部分属于 OVO 的工程完善目标，不是已证明竞品采用的内部实现。语言智能在 Claude Code 中也依赖相应插件；无需据此引入一个新的 IDE 产品。[Claude Code 能力边界](https://code.claude.com/docs/en/how-claude-code-works)。

## 完善规格与阶段门槛

保持“超级个人 Coding Agent + 统一 Harness + 可组合模块”定位，沿用 TypeScript strict、ESM、Node `>=22.13.0` 和 pnpm 锁文件。保留已有工具/命令的兼容入口，冗余实现通过迁移和弃用收敛；不一次性换架构，不新增产品中心、评测平台、独立 Agent 产品或重设计 UI，不更换记忆检索算法。

| 阶段 | 成果 | 必须能证明的行为 | 对应任务 |
| --- | --- | --- | --- |
| A：形成基线 | 固定任务集与能力状态表，现有断路有测试 | 区分真实执行、模拟验证、不支持；效果与费用有固定测量方法 | T01 |
| B：可信执行 | 策略接入、环境最小化、物理进程归属、已验证平台隔离、恢复与审批 | 越界操作被真实阻止；取消不提前释放资源；崩溃不重复副作用；审批对象不串线 | T02–T04、T07–T08 |
| C：一致的核心循环 | 模型协议、effort、完整统计、事件/非交互入口、上下文保真 | 一个修改任务在 CLI/Ink/JSONL 走同一引擎；真实参数生效；压缩不丢已知约束 | T05–T06、T09–T10、T13–T14、T16 |
| D：长任务和代码理解 | 子代理并发/续接、记忆更正、语言服务、回合检查点、终端会话 | 不同工作树可并行；续接不重做发现；语义诊断更新；恢复保全用户改动 | T11–T12、T18–T20 |
| E：扩展和发布资格 | 远程 MCP、插件运行组件、真实平台资格 | 启用后组件实际可用；禁用后实际撤销；支持声明绑定真实安装包和平台证据 | T15、T17、T21 |

阶段是依赖和验收边界，不是预估完成日期。优先做可快速验证的现有断路（G07/G16/G18/G19）与 P0 执行工作，不能等所有大型平台功能做完才修这些缺陷。

验收默认用行为证据：固定请求记录、真实进程/服务器、文件产物和退出码。离线固定 fixtures 为强制回归；需要费用/账号的真实模型实验单独明确模型、预算和次数，不隐式消耗账户。完整计划在 [2026-10-03-agent-core-roadmap.md](superpowers/plans/2026-10-03-agent-core-roadmap.md)。

## 暂缓项和收敛原则

- 暂缓新的模式、自动梦境、仪表盘、插件市场、云协作、额外 UI 和“多代理产品”。先证明现有模块改善任务结果。
- 不要求换语言、向量数据库或新增一套调度框架。保留已有模块钩子、准入、锁、结果契约与工作树验收。
- 合并双 hooks、双 plugins、双 instruction discovery 的运行模型，配置迁移失败保留原文件；对暂不支持的能力显示 unsupported，避免只有名称的“已启用”。
- 真实质量评测同时观察正确性、无关改动、费用、延迟、人工介入和失败恢复。用“更多测试/更多 token”代替效果数据不成立。
- 同模型比较用于衡量 OVO 修改前后的 harness；产品级 Codex/Claude Code 比较必须报告各自实际模型和限制，不能把模型差异归因于代码架构。
