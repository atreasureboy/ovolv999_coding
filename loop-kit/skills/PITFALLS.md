# PITFALLS — 已知雷区(技能三件套 3/3)

> agent 每轮 PLAN 必读。**遇到一个坑就追加一条**(LOOP §4.5 ACT 步骤)——这是系统变聪明的唯一方式。
> 格式:`<症状> → <别这么做> → <该这么做>`。带文件:行号更好。

---

<!-- 示例(删掉,换你的):
- 跑 `npm test` 前必须先 `npm run build`,否则测试 import 旧产物报假错 → 永远先 build。
- 不要改 `src/legacy/parser.c`,它有未文档化的副作用,会破坏 X → 改 `src/parser2.c`。
- tests/conftest.py 里的 fixture `db` 是全局共享的,测试间有状态泄漏 → 每个 test 用 `db_reset`。
-->

(初始为空,靠循环积累。第一条由你或 agent 遇坑时写。)
