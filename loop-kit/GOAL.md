# GOAL — 任务目标

## 目标(一句话)
将 ovolv999 从通用 agent 基座特化为好用的 coding 工具，并集成 loop-kit 自主循环协议作为内置能力。

## 详细说明
- 要解决的问题：当前 ovolv999 是通用基座，缺少 coding 场景的专用优化（项目上下文检测、git 感知、编辑 diff 显示、loop 循环模式）
- 期望的行为：
  1. 系统提示词改为 coding 专用（参考 Claude Code 风格）
  2. 自动检测项目类型（package.json/tsconfig/git）注入系统提示词
  3. Edit 工具显示 diff（改了什么一目了然）
  4. loop-kit 协议集成为 `ovolv999 --loop` 模式（内置而非外部脚本）
  5. skills/COMMANDS.md 自动从 package.json 推断
- 范围(做哪些)：
  - src/prompts/system.ts — coding 专用提示词
  - src/config/projectContext.ts — 项目检测（已创建，需集成）
  - src/tools/fileEdit.ts — diff 显示
  - src/core/loopEngine.ts — loop 协议引擎（内置）
  - bin/ovogogogo.ts — --loop 参数 + 项目上下文注入
- 范围(不做哪些)：
  - 不改引擎核心循环（runTurn 不动）
  - 不改模块系统
  - 不加新依赖

## 明确不做(will_not_do)
- 不改 src/core/engine.ts 的 runTurn 方法
- 不改模块系统（module.ts / moduleRegistry.ts）
- 不加新的 npm 依赖
- 不动测试框架

## 背景上下文
- ovolv999 已有完整的 agent 基座：统一 Harness + 模块系统 + AgentConfig + Memory + Hooks
- loop-kit 是一套自主循环协议，核心是 WAKE→SCAN→PLAN→DO→REVIEW→CHECK→ACT
- 项目使用 pnpm + TypeScript ESM + vitest + eslint
- 当前 66 个测试全绿，tsc 0，eslint 0
