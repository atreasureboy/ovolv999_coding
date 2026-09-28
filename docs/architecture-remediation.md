# 架构正确性整改交付记录

本轮已实施并验证主要 P0/P1 修复；仓库整体尚未达到全部检查通过。未完成项和平台限制保留在本文末尾，不作为已关闭问题处理。

## 版本与范围

- 目标：`atreasureboy/ovolv999_coding`；remote 已核对，无 `_pro` 仓库操作。
- 审计 SHA 和实际起始 HEAD：`bb5ed63c66636d790f6a2cc9707fc2c7d73cd0cd`。
- 完成验证时改动尚未提交；随后用户明确授权提交并推送到 GitHub。包含本记录的整改提交即实现版本，可通过 `git log -1 --format=%H -- docs/architecture-remediation.md` 查询。验证时的文件哈希清单保存在 `.artifacts/architecture/final-workspace-manifest.json`，与提交 SHA 区分。
- 起始工作区干净。没有 reset、自动提交用户产物或清理用户未提交文件。失败测试产生的本仓库 `new.txt` 已移入证据目录保存。
- Windows、Node v24.20.0、pnpm 11.25.0；沿用 `pnpm-lock.yaml`，未升级依赖。Linux 未运行。
- 环境/原始检查记录见 `BASELINE.md`。发布包使用显式白名单及单独编译配置；严格类型检查仍覆盖测试。

## 修复与行为证据

| 问题、根因与调用链 | 实施结果 | 回归证据 |
| --- | --- | --- |
| ExitWorktree 合并后强制删除，未提交内容不属于合并提交 | 默认保留 staged、unstaged、untracked、ignored 内容；绑定原始目标、基线和产物；证据真实哈希与冻结定义匹配；只允许快进自动合并；未知 action 不退化为 discard | `worktreeSafety.test.ts`：真实临时 Git 仓库覆盖脏树、目标移动、冲突、清理失败、失效证据、显式丢弃 |
| 模型 stop、DONE.flag、子进程退出被误认为验收成功 | 引入七种终态与独立 verification；Agent 在真实验证及资源收尾后上报；Loop 冻结目标和验收条件并重新执行，旧标记没有证明力；CLI/Ink/后台保留真实终态 | `agentOutcome`、`loopOutcome`、`outcomePropagation`、`cliOutcome`、`backgroundOutcome`；打包 CLI 成功与失败路径 |
| ask 缺回调仍执行，非 Ink 默认 bypass | 无审批通道返回 needs_input、零副作用；显式 deny 优先；保留明确 auto/bypass；CLI 显示实际模式 | `cliPermissions`、`engineContract`；已安装 CLI ask 退出 2、未生成目标文件 |
| raw/effective 配置混用、计划模式快照过期 | 统一克隆后的有效配置；主角色与子角色分开；每个工具和下一次请求读取当前模式；PermissionManager plan 也反映到 schema 和系统提示 | `engineContract`：同批 EnterPlanMode→Write、审批拒绝/通过、无通道、角色与配置隔离 |
| 全局读取记录被其他 Run 清空或借用 | RunContext 持有独立 FileReadState；工具由上下文读取快照；原有独立调用导出作为兼容层保留 | `engineContract`、`fileEditAtomic`、`workspaceFileContainment` |
| Promise.all 早失败、无限等待及迟到结果 | 每调用规范化结果；受限只读并发；可写工具串行；每个 tool_call 恰好匹配结果，重复供应商 ID 重新标识；未结束物理任务隔离工作区直到真正结束 | `engineContract`、`runContextReview`、`engineAbort`；包含忽略取消的工具、stream iterator、dispose 和已启动 Run 竞争 |
| Bash 前缀白名单误判写操作 | 重定向、替换、换行、git branch/remote 变更及不确定参数走写锁；git --output、rg --pre 不再并行只读 | `workspaceFileContainment`、`bashTool`，实际 git diff 写文件验证 |
| 子任务 cwd 与实际文件、验证目录不一致 | Agent 显式绑定工作区；同一工作区修改型子任务串行；Read/Write/Edit/NotebookEdit 对子任务检查真实路径及现有祖先，拒绝绝对路径、父目录和目录链接逃逸 | `agentOutcome`、`workspaceFileContainment`：37 项边界测试，含 Windows junction |
| 不同 worktree 共享 Git 管理目录却各自加锁 | 原生工作树变更和识别出的 Git shell 命令按 common Git directory 协调；后台命令锁持续到进程真正 close | `worktreeCoordination`：前台、直接后台、托管后台、排队取消及不同仓库独立运行 |
| 取消域建立过晚、验证同步阻塞、dispose 未等待 | Run 建立即具 signal，覆盖 boot、模块、模型、工具、审批、验证及 finalization；异步验证具进程树终止和输出上限；幂等、逐资源、限时 dispose；未终止资源明确记录并隔离 | `cleanupAsync`、`verificationEvidence`、`runContextReview`、`agentOutcome`；LSP 启动失败注册 error 监听避免未处理异常 |
| MCP 每轮重连及列工具失败漏清理 | Session 内按配置复用连接，single-flight；半初始化失败关闭；取消/超时传递；memory 每轮检索继续保留 | `mcpLifecycle`：本地真实 stdio 进程、多轮、半初始化和取消；不是在线服务证明 |
| 模型切换窗口/模块过期，重试丢文本或绕预算 | 共享请求入口剥离内部 provenance、检查取消和完整预算、禁止隐藏 SDK 重试；使用现有模型元数据，未知模型保守值；续写累加，空/过滤/不完整流不能算完成 | `engineContract`、`compact`、`queryStateMachine`、`runtime3`；实际 HTTP 离线 provider |
| Snip(0)、裁剪切断 tool 调用组及伪用户控制消息 | 共用消息分组规则；校验 finite/整数/范围；保留当前用户目标、未结算调用；恢复填入显式取消结果；聚合预算包含标记，保留大输出落盘 | `messageGroups`、`snip`、`runtimeFixes`、`sessionAuditFixes` |
| 存储失败仍 Stored、读取失败丢旧视图、JSONL 并发覆盖 | 明确持久化结果；失败不确认缓存版本；原 JSONL 布局增加互斥、原子替换和崩溃恢复；来源声明与验证状态分开 | `persistenceLifecycle`、`persistenceMultiprocess`：真实进程 append/rewrite/崩溃恢复 |
| FileHistory 最旧保留版冒充原始版、备份失败仍修改 | 原始基线独立保留，覆盖新建/删除状态；备份失败时原生文件写入拒绝继续 | `fileHistory`、`persistenceLifecycle`、`fileEditAtomic` |
| 验收前后产物变化、忽略目录漏检 | Git 清单与过滤后的文件扫描共同识别产物；运行日志目录由可信调用方明确排除并继承；验收前后及 finalizer/dispose 后比较；原生文件写入未被清单识别时 blocked | `verificationEvidence`、`engineContract`、`agentOutcome`；已安装 CLI 在 Git 忽略的临时目录真实复现并修复 |

## 权威状态与生命周期

- Engine/Session 拥有长期模块实例、MCP 连接、工具注册、历史接口与有效配置；同一 Engine 禁止重入。
- RunContext 拥有 runId、parentRunId、familyId、工作区、AbortController、读取快照、策略修订、待结束操作、工具失败和最终结果。共享资源门仅管理互斥与隔离，不替代 Run 状态。
- 工具执行和模型请求是当前 Run 的受控操作。parent signal 传递给子 Run；迟到操作不向新 Run 发布结果。无法终止的底层操作使工作区保持隔离。
- PermissionManager 管规则和显式权限模式，Engine 将其与有效角色/Plan Mode 一并检查；UI 只收集审批和展示结果。
- 验收定义在执行前冻结；证据包含 workspace、artifactVersion、definitionHash、runId、命令与实际退出状态。最终产物再次变动时证据失效。普通分析无产物变化可以 not_applicable；代码修改无可执行验收时 blocked。
- WorktreeManager 接受证据并在合并前独立核对；CLI/Ink/后台只映射终态，不自行宣布验收成功。

## 检查与发布证据

所有日志位于 `.artifacts/architecture/`，未发布到远程。

| 实际检查 | 退出码与结果 | 日志 |
| --- | --- | --- |
| 起始直接类型检查 | 0 | `baseline-typecheck-direct.log` |
| 起始直接完整测试快照 | 1；3206 通过、223 失败、7 跳过、1 未处理异常；该快照已含第一批失败回归，因此不是纯原提交的精确分母 | `baseline-tests-direct.log` |
| 起始 lint | 1；493 errors、9 warnings | `baseline-lint-direct.log` |
| 新目录复制同一清单/锁文件后 `pnpm install --frozen-lockfile` | 0，228 项依赖，esbuild 构建允许项明确 | `clean-frozen-install.log` |
| `pnpm exec tsc --noEmit` | 0 | `final-typecheck.log` |
| `pnpm run build` | 0 | `final-build.log` |
| `pnpm exec vitest run --maxWorkers=4` | 1；3544 通过、40 失败、7 原有跳过，151 个文件通过、5 个文件失败；无未处理异常 | `final-tests.log` |
| 全库 `pnpm run lint` | 1；474 errors、9 warnings（基线 493/9）；全库仍不干净 | `final-lint.log` |
| 本次核心运行时、结果、存储、工作树各自范围 ESLint | 0 | `root-final-lint.log`、`outcome-lint.log`、`persistence-lint.log`、`worktree-final-lint.log` |
| npm pack 与独立临时目录安装 | 0；390 项文件，638900 字节；没有 tests、开发资料、.env、.git 或源码映射入包 | `package-final.json`、`package-final-install.log` |
| 已安装编译后 CLI + 本机 HTTP 模拟接口 | 0；8 场景、9 次模型请求；--help/--version、raw --pipe、单次任务、普通 stdin、ask 无写入、真实失败验收、Read→Edit→成功验收 | `package-final-smoke.log`、`package-smoke-results.json` |

打包使用系统 Node 附带的 npm CLI 文件，因为宿主 npm 包装入口曾指向缺失文件；完整命令和可复现离线冒烟脚本保存在证据目录。临时发布安装使用 `--ignore-scripts --no-audit --no-fund`，没有声称发布成功或安全审计完成。干净依赖安装另用未关闭构建脚本的 frozen pnpm 验证。

## 兼容、迁移与回滚

- 保留现有公开工具导出、命令、角色、CLI/Ink、Skills、记忆检索算法和数据主目录。工具/模块实际能力范围见 `architecture-capabilities.md`。
- `TurnResult.reason/output`、`ToolResult.content/isError` 保留；新状态/证据字段可选，旧嵌入调用兼容读取。后台旧 stopped 状态仍可读，新增 outcome 不等同于进程存活状态。
- `runVerification` 改为可等待异步执行；仓库调用方已迁移，外部调用方需要 await。Engine.dispose 现在应被 await，失败时拒绝并报告未完成资源。
- 旧 Worktree 缺基线/目标元数据会被保留并拒绝自动合并，不推测历史基线。显式 discard 仍存在且需要权限。
- JSONL 主存储不迁移成第二数据库；新增来源/持久化字段保留旧数据并标记未验证。历史备份保留原始基线；不把最旧裁剪版本冒充原始文件。
- 回滚应使用对应整改提交的 revert，并先保存之后新增的用户改动；不要对目录执行强制 reset 或删除 `.ovogo`/`.ovolv999` 用户数据。若需要继续使用旧运行时，应先结束所有运行中的新 Run。

## 第二轮独立复核

实现者交叉复核了 Engine/RunContext、结果链、Worktree 和证据边界，并提供可执行复现。发现并修复：流迭代器无界等待、dispose 超时未隔离、已启动 Run 绕过隔离、同名子任务成功抹掉其他失败、finalizer 改动未使验收失效、真实产物哈希未比较、跟踪的 dist 文件被排除、CLI 隐式 bypass、计划退出伪审批、子任务路径逃逸、Bash --output 误判。复核原始记录在 `persistence-independent-review.md`、`root-independent-review.md`、`worktree-report.md`；其中早期 findings 是检查点，最终状态以回归与本报告为准。

## 尚未完成与验证限制

1. 全库仍有 40 项测试失败：budget 2（日期/时区）、daemon 16（Windows socket 路径）、magicDocs 9（依赖 Unix find/head）、fileEditAtomic 10（Unix mode/file symlink）、sessionAuditFixes 3（Unix mode）。这些没有关闭，也未新增 skip 掩盖；Windows junction 边界测试已实际执行。
2. 全库 lint 尚未通过，详情保留。未做与整改无关的数百处格式/类型风格清理。
3. Linux、在线模型、真实 HTTP/OAuth MCP、外部 ClaudeCode/tmux、完整 Windows detached 后台进程树停止均未验证；stdio MCP 和本机模拟接口已验证。
4. 工作区门和 common Git gate 是同一进程内协调。原生子任务文件工具有路径边界，但任意 shell、别名、外部进程、指向其他仓库的 git 参数没有 OS 级隔离保证。低层同步 WorktreeManager API 为兼容保留，外部直接调用必须自行协调。
5. 子进程无法确认退出时会隔离工作区并报告未结束资源，无法保证操作系统一定允许强制终止。本机沙箱曾拒绝 taskkill；获准执行环境中实际取消测试通过。失败测试产生的已识别残留进程均已确认退出。
6. 产物清单有明确生成目录排除；已跟踪生成文件仍会纳入。原生文件写入若只有被排除产物变化会 blocked，要求显式产物验收。任意 Bash 仅改排除目录、写到绑定范围外，以及检查清单与执行之间的外部文件系统竞争，仍不是完整安全边界。
7. 通用项目脚本证明其实际执行结果，不证明任意自然语言目标语义完整。大型仓库的完整文件哈希扫描成本、全部长耗时旧命令的异步改造、跨进程工作区互斥和精确辅助请求成本归集未全部完成；请求日志会标记估算/未知，不能推断精确总费用。
8. 用户在获知上述检查结果后授权提交并推送；本轮没有发布 npm 包。GitHub 代码交付不代表“项目已全绿/可发布”。
