# STATE — ovolv999 迭代循环

> 最终目标：参考 `claude-code/` 逆向源码，把 ovolv999 迭代成"超级个人 coding 工具"。
> 我（glm-5.2）是指挥者，通过 amux 委托 Claude Code (MiniMax-M3) 执行实现，节省 token。

## 当前阶段
**Iteration 5 完成**。重点：从 claude-code 借鉴 3 个功能特性（Agent 工具过滤 + CJK 输入归一化 + Snip 手动裁剪工具）。通过 amux 委托 Claude Code 实现全部代码变更。

## 当前目标适配度：约 85%

### 已适配（可直接保留）
- 统一 Harness（ExecutionEngine）+ 7 步 Boot Sequence
- 模块系统：memory / critic / workspace / reflection / mcp（5 模块）
- 4 个内置 preset + 零代码自定义角色
- Memory 三原语 + 来源归因 + session 整合闭环
- 验证闸门 + 调用链追踪 + 6 种 Hooks
- 29+ 工具（+SnipTool）+ MCP 动态注入 + 工具元信息并发调度
- 统一权限管理 + **风险分类器（3 级 + 命令注入检测）**
- 后台任务生命周期 + 流式引擎 + 上下文压缩
- **Time-based microcompact（零 LLM 成本上下文裁剪）**
- **Path 安全工具（traversal/null-byte 防护）**
- **Agent 子代理工具过滤（disallowedTools + 全局禁用集）**
- **CJK 输入归一化（全角→半角 + 全角空格→半角）**
- **SnipTool — 零 LLM 成本手动上下文裁剪（工具 + /snip 命令）**
- Poor/Budget 模式 + Plan 工具闭环
- 仅 3 个 runtime deps（openai/glob/zod）

### 本轮新增（Iteration 5 — 功能借鉴）
- ✅ Agent 工具过滤：`AgentConfig.disallowedTools` + `SUB_AGENT_DISALLOWED_TOOLS` 全局禁用集（Agent/EnterPlanMode/ExitPlanMode/VerifyPlanExecution）+ `filterToolsForSubAgent()` 集成到 engine.ts
- ✅ 字符串工具：`normalizeFullWidthDigits` / `normalizeFullWidthSpace` / `normalizeCJKInput` / `escapeRegExp` / `safeParseJSON`；CJK 归一化已接入 engine.ts 用户消息构造
- ✅ SnipTool：`src/tools/snip.ts`（零 LLM 成本手动裁剪）+ `/snip [N]` slash 命令 + `engine.queueSnip()` 延迟裁剪 + `applySnipToMessages()` 共享裁剪逻辑 + `[snip]` 边界标记
- ✅ 47 个新测试（agentToolFilter 8 + stringUtils 29 + snip 10）

## 本轮证据
- `pnpm build` → tsc **0 error**
- `pnpm lint` → **0 error / 0 warning**
- `pnpm test` → **48 files / 1107 tests passed**（基线 1060 → +47 用例）
- `git diff --stat` → 23 files changed, +695 -67
- amux peek 全程可见 Claude Code 工作过程（类模式适配、lint 修复、测试调试）

## 当前 P0
- 无

## 当前 P1
- 无

## 已知 P2（未修复，低风险）
- 模块级全局状态（todo/fileState/shellSession/modes 单例）— 并发子 agent 场景风险，单进程低风险
- Renderer fd 泄漏 — 异常路径未调 destroy()
- LoopEngine acceptance 经 shell — 信任边界=用户项目配置

## 下一步
1. **下一轮迭代可选**：FeatureFlag 系统、Worktree 隔离、Provider 抽象、pathSecurity 加固工具路径检查
2. 可选：compactable-tool 白名单微调（Agent/Task 结果不入白名单）
3. 可选：用 pathSecurity 加固 FileRead/FileWrite/Bash 工具的路径检查

---

## 可以从 STATE.md 继续执行的位置
工作区改动未提交。下一轮可直接：读 STATE → 选迭代方向 → 写 DETAIL_PLAN → amux send 委托 Claude Code → verify。
