# ACCEPTANCE — 验收清单

- [ ] A1: 类型检查 — `npx tsc --noEmit`
- [ ] A2: lint — `npx eslint src/ bin/ tests/`
- [ ] A3: 测试 — `npx vitest run`
- [ ] A4: 系统提示词含 coding — `grep -c "coding" src/prompts/system.ts` (exit 0 if >0)
- [ ] A5: 项目上下文检测 — `grep -c "detectProjectContext" bin/ovogogogo.ts` (exit 0 if >0)
- [ ] A6: Edit diff 显示 — `grep -c "diff" src/tools/fileEdit.ts` (exit 0 if >0)
- [ ] A7: loop 引擎存在 — `test -f src/core/loopEngine.ts`
- [ ] A8: --loop 参数 — `grep -c "loop" bin/ovogogogo.ts` (exit 0 if >0)
