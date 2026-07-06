# COMMANDS — 构建/测试/质量门命令

## 环境准备
- `pnpm install`

## 构建
- build: `pnpm run build`

## 测试
- test: `npx vitest run`
- test (watch): `npx vitest`

## 质量门
- lint: `npx eslint src/ bin/ tests/`
- typecheck: `npx tsc --noEmit`
- format-check: `npx prettier --check src/ bin/`

## CI 等价性
- 本地质量门 = 远程 CI（无远程 CI，本地是权威）
