# CONVENTIONS — 项目约定

## 代码风格
- TypeScript ESM (NodeNext module resolution)
- 无分号（prettier 配置）
- 单引号
- 2 空格缩进

## 命名约定
- 类: PascalCase (ExecutionEngine, MemoryModule)
- 函数/变量: camelCase (runTurn, systemPromptTokens)
- 常量: UPPER_SNAKE (MAX_CALL_DEPTH, CRITIC_INTERVAL)
- 文件: camelCase (engine.ts, agentPresets.ts)

## 目录结构
- `src/core/` — 引擎核心（engine, types, module, compact, memory）
- `src/modules/` — 内置模块（memory, critic, workspace, reflection）
- `src/tools/` — 工具实现（14 个工具）
- `src/prompts/` — 提示词
- `src/config/` — 配置（hooks, settings, projectContext）
- `bin/` — CLI 入口

## 模式与偏好
- 错误处理：best-effort，catch 不 throw（引擎不能因日志/记忆失败而崩溃）
- 工具返回：{ content: string, isError: boolean }
- 模块生命周期：boot → onIteration → onToolCall → onComplete
- 上下文预算：统一百分比 70%/85%

## 不要做
- 不加新的 npm 依赖（保持 3 个 runtime deps）
- 不改 runTurn 核心循环
- 不改模块系统接口
