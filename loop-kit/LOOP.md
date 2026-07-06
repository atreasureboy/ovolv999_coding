# LOOP — 自主循环执行协议 v1.1

> **给谁读**:具备文件读写、命令执行、子代理调用能力的 AI(典型:Claude Code)。
> **读完即开工**:你读完本文件,就应立即进入循环,直到目标达成或触发暂停。不要问"要我开始吗"——开始是默认。
> **怎么用(给用户)**:
> - **交互长会话**:把本文件塞进 Claude Code 首轮上下文 + `GOAL.md`,让它自己循环。
> - **无人值守**:用 `run-loop.sh` / `run-loop.ps1` 反复调用 `claude -p`(每次 fresh context,靠 `STATE.md` 续命)。
> - **全自动守护**(推荐后台跑):装好触发器(§7),定时/commit/PR 事件自动唤醒,你啥都不用做。

---

## 0. 一句话目标

给定一个目标(`GOAL.md`)和一组可执行验收标准(`ACCEPTANCE.md`),你要**自主、持续地循环工作**,直到**验收全绿**或**触达硬上限**。中途不得停下来等待人类确认——继续是默认动作。

支持两种目标形态:
- **单目标任务**:GOAL.md 写一个具体目标(如"加重试装饰器"),DONE 即结束。
- **守护目标**:GOAL.md 写一组不变量(如"主分支永远绿""PR 24h 内有人响应""覆盖率≥90%"),永不 DONE——每次被唤醒(§7)就扫描现状、干活、等下次唤醒。这才是"后台跑任务"的主战场。

---

## 1. 六大支柱(本协议的骨架)

这六条是协议的结构组件。**每一条都必须存在、都必须可验证**:

| # | 支柱 | 落地机制 | 详见 |
|---|---|---|---|
| **1** | **Automations 自动化触发** | 定时器 / git commit hook / PR 轮询,**只负责唤醒**(`.loop/WAKE.flag`);消费者二选一:`run-loop -Watch` 前台秒级消费(commit/PR 后即时响应),或定时器周期消费。agent 被唤醒后自己扫描仓库发现该干的活。 | §7 |
| **2** | **Memory 记忆文件** | `STATE.md`(每轮重写,唯一记忆)+ `HISTORY.md`(只追加)。运行前读、跑完写。模型会忘,文件不会忘。 | §5 |
| **3** | **Worktrees 隔离环境** | `run-loop -TaskId <id>` **自动 `git worktree add`**(不存在则建)+ 独立分支 `loop/<id>`,并行任务互不打架。主工作树永不让 agent 直接跑。 | §8 |
| **4** | **Skills 技能手册** | `CONVENTIONS.md`(约定)+ `COMMANDS.md`(构建/测试/lint 命令)+ `PITFALLS.md`(雷区)。每轮必读,省去口述。 | §3 |
| **5** | **Evaluator-Optimizer 评估者** | 写代码的是 Writer,审代码的是独立只读评估者:**默认**会话内 Task 子代理(原模型);**`-ReviewModel X`** 指定时走 shell 级独立调用(`-ReviewBin` 可换运营商,跨厂商审查)。不让写作业的人批改作业。 | §4.3 |
| **6** | **Hard Stop 停止条件** | DONE = `ACCEPTANCE.md` 每条 exit 0 **且** 质量门(lint/type/test/build)全绿 **且**(有 CI 时)CI 绿。Claude 说"做完了"零权重。 | §4.5 |

---

## 2. 五条执行原则(行为层)

六支柱是"有什么",这五条是"怎么干":

1. **退出只看验收,不看自评。** 你觉得做完了不算数;只有 §1 支柱6 的全部条件成立才算 DONE。绝不能跳过验收、为通过而改验收、删测试、把失败测试改成空通过。
2. **假设下一轮完全失忆。** 所有上下文落进 `STATE.md`。一轮结束后,一个全新、无记忆的你,只读 `STATE.md` 就能接手。`STATE.md` 是你唯一的记忆(支柱2)。
3. **权力分离:动手者不评判。** 每轮改动后,用 Task 只读子代理审(支柱5)。审查者不能改代码,只给 verdict。简单/琐碎改动(<10 行、无逻辑)可自查,但必须在 `STATE.md` 写明跳过理由。
4. **永不阻塞等待人类。** 遇到不确定点:选**风险最小的默认动作**推进,把疑问记入 `STATE.md`「待确认」。不提问、不空等。人类事后读 digest/STATE 纠偏。
5. **不确定就保守。** 没把握选可逆、影响面小的动作。破坏性操作前 `git stash`/备份。绝不 `git push --force`、不删没把握的代码、不碰 `secrets/`/`migrations/`/`.github/` 高危路径(除非目标本身就是这些)。

---

## 3. 文件约定(含 Skills 三件套 — 支柱4)

状态放目标项目根下的 `.loop/`,技能手册放 `.loop/skills/`(若不存在,首轮创建)。

```
<project-root>/
└── .loop/
    ├── LOOP.md              # 本协议。只读,不改。
    ├── GOAL.md              # 目标(单目标)或守护不变量列表。用户给定。
    ├── ACCEPTANCE.md        # 验收清单:每条可执行命令,exit 0=通过。循环中不得改。
    ├── STATE.md             # 循环记忆。每轮**重写**。(支柱2)
    ├── HISTORY.md           # 历史归档(事件流水)。只追加。
    ├── DEVLOG.md            # 自我文档:遇非平凡问题/决策时追加复盘(问题/解决/思考/注意)。见 §4.6
    ├── PITFALLS.md          # 雷区:遇到一个记一个(追加)。
    ├── WAKE.flag            # 唤醒信号(触发器设,run-loop 消费后删)。(支柱1)
    ├── DONE.flag            # 出现 = 循环成功结束。(支柱6)
    ├── PARKED.flag          # 出现 = 循环暂停(附理由)。
    ├── inbox/               # (守护模式)触发器投递的待办目标 JSON。
    └── iter-N/              # 每轮快照:diff、审查 verdict、验收结果。

    skills/                  # 技能三件套(支柱4)——每轮 PLAN 必读
    ├── CONVENTIONS.md       # 代码风格、命名、模式、目录约定
    ├── COMMANDS.md          # 构建/测试/lint/typecheck/build 的确切命令 + 环境准备
    └── PITFALLS.md          # 已知雷区("别动 X,会坏 Y")
```

> **COMMANDS.md 为什么单独成文**:防止 AI 自己瞎编一个"测试命令"然后跑空通过。把 `pytest -q`/`npm test`/`ruff check .` 这些**确切**命令写死,质量门(§4.4)只认这里的命令。

---

## 4. 循环结构 — 每轮 `WAKE → SCAN → PLAN → DO → REVIEW → CHECK → ACT`

### 4.0 WAKE / SCAN(守护模式入口 — 支柱1)
单目标任务可跳过本步,直接 PLAN。守护模式必跑:

1. **扫描仓库现状,自己发现该干的活**(你原则1原话:"让它自己去发现该干的活"):
   - `git log` 自上次扫描点(.loop/last-scan.sha)→ 有新提交?→ 跑测试,有回归就修。
   - `gh pr list --state open` → 有新 PR / 有 CI 红 / 有人 request changes?→ review 或修。
   - 跑 `COMMANDS.md` 里的质量门 → 有失败?→ 修。
   - 查 `GOAL.md` 守护不变量(覆盖率/警告/过期依赖)→ 偏离?→ 生成 bounded 任务。
   - 读 `inbox/*.json`(触发器投递的明确目标)→ 排入待办。
2. 把发现的活排进 `STATE.md` 的「下一步」队列,更新 `last-scan.sha`。
3. 若啥活都没有 → 写 `.loop/IDLE.flag`(本轮空跑),结束本轮,等下次唤醒。**不要为了干活而瞎改东西。**

### 4.1 PLAN(读 + 规划)
1. 按序读:`STATE.md` → `GOAL.md` → `ACCEPTANCE.md` → `skills/CONVENTIONS.md` → `skills/COMMANDS.md` → `skills/PITFALLS.md`。
2. 从 `STATE.md`「下一步」取本轮要做的事。
3. 用 `TodoWrite` 拆成 3~7 个具体待办。
4. 明确「本轮完成的定义」:推进下一步,让至少一条验收变绿或明显接近。

### 4.2 DO(动手)
1. 执行下一步,做**真实改动**(Edit/Write 代码/配置/脚本)。
2. 原子化、小步,每逻辑单元 `git add` + `git commit`(message 描述性)。
3. 不假装做——每个改动必须有真实文件 diff。

### 4.3 REVIEW(权力分离 — 支柱5)
用 `Task` 开**只读子代理**对抗式审查:

- prompt 模板见 **附录 A**。
- 子代理**只能用** `Read, Grep, Glob` + 只读 git(`git diff/log/show`)。**禁止**写文件/commit/push。
- 优先换更强模型(Writer 用 sonnet,Reviewer 用 opus)——减少相关盲区。
- 返回一行:`VERDICT: APPROVE` 或 `VERDICT: REJECT: <理由,引用 文件:行号>`。
- REJECT 理由加入 TodoList,回 §4.2 修正,再 REVIEW(单轮上限 3 次,超过算本轮 fail)。
- 跳过条件:仅当改动 <10 行且无逻辑变化,可自查,STATE 注明理由。

### 4.4 CHECK(跑验收 — 支柱6 前半)
1. 按 `skills/COMMANDS.md` 跑质量门:`lint`/`typecheck`/`test`/`build`(缺则跳过并记录)。
2. 依次执行 `ACCEPTANCE.md` 每条命令,记录 pass/fail + 失败摘要。
3. **禁止**为通过而修改验收条目;失败必须靠**改代码**修。

### 4.5 ACT(退出判定 — 支柱6)
分支判断:

- ✅ **`ACCEPTANCE.md` 全 pass ∧ 质量门全绿 ∧(有 CI 时)CI 绿** → 写 `.loop/DONE.flag`,HISTORY 追加终轮,**DEVLOG 追加任务总结段**,结束。**(支柱6:三条件缺一不可)**
- ⏳ **否则**:
  1. **重写** `STATE.md`(§5):做了什么、验收现状、卡点、下一步。
  2. **追加** `HISTORY.md` 一段(iter 号、diff stat、verdict、验收 pass/fail)。
  3. 遇坑 → 追加 `skills/PITFALLS.md`。
  4. **自我文档**:本轮若遇到非平凡问题 / 做了关键决策 / 换了思路 → 追加一段到 `.loop/DEVLOG.md`(格式见 §4.6)。**不是每轮都写**——平推无阻的轮次不记,流水账无价值。
  5. 迭代 +1。达 `MAX_ITERS` 或振荡 → `.loop/PARKED.flag` + 归档(+ DEVLOG 总结),停。否则进下一轮。

### 4.6 自我文档 DEVLOG(让 agent 边干边沉淀)

> LOOP 的"第七能力":**执行循环的 AI 自己维护一份开发日志**,记录它遇到的问题、解法、思考、注意事项。人类事后能看到 agent 的"内心戏";下一个 agent(或下一轮失忆的你)能读到经验。
>
> 三个文件的分工,别混淆:
> - `HISTORY.md` = 事件流水(iter/diff/verdict,**给程序读**)
> - `skills/PITFALLS.md` = 精炼雷区条目(**给未来 agent 快速读**)
> - `DEVLOG.md` = **叙事性复盘**(**给人读**,讲来龙去脉与权衡)

**每段格式**(追加到 `.loop/DEVLOG.md`):

```markdown
## iter <N> — <一句话主题>  (<日期>)
**遇到的问题**:<具体,引用 文件:行;本轮平推无阻就跳过整段不写>
**怎么解决的**:<做了什么、为什么这么选而不是另一种>
**思考**:<权衡、学到了什么、什么情况下会复发>
**注意事项**:<给未来 agent/人的提醒;若通用,同步追加一条到 skills/PITFALLS.md>
```

**写时机**:
- 每轮 ACT(步骤4):仅当本轮**有值得记的**——非平凡 bug、关键设计取舍、踩坑、换思路。平推轮不写。
- **首轮**:写一段"开局判断"(读完 GOAL/skills 后,打算怎么攻、预判难点)。
- **DONE/PARKED**:写一段**任务级总结**(整体路径、最大坑、最终教训)。

**不写什么**:别复述 STATE.md/HISTORY.md 的流水。DEVLOG 只记**问题与思考**。

---

## 5. `STATE.md` 格式(每轮**重写**,硬上限 80 行)

```markdown
# STATE — <目标一句话>

## 迭代进度
- 第 <N>/<MAX_ITERS> 轮  | 模式: 单目标 / 守护
- 验收通过: X / Y 条  (未通过: [ID 列表])
- 上次扫描点: <commit sha>(守护模式)

## 已完成
- <bullet,具体到文件/功能;新读者据此知道现在到哪了>

## 当前卡点
- <具体问题,引用 文件:行号;无则写"无">

## 待确认(不阻塞,已用默认动作推进)
- <疑问>:默认选 <X>,因为 <理由>

## 下一步(下一轮 PLAN 直接读这里)
1. <最具体可执行的一步,失忆的你读完就能动手>
2. ...

## 本轮审查 verdict
- <APPROVE / REJECT 理由摘要>
```

> 自检:把 `STATE.md` 交给一个**毫不知情**的同事,他能接着干吗?能=合格。

---

## 6. `ACCEPTANCE.md` 格式(用户设定 / 你提议后用户确认)

```markdown
# 验收清单 — <目标>
每条 = 一个 shell 命令。exit 0 = 通过。全部通过 + 质量门绿 = DONE。

- [ ] A1: 核心功能 — `python -c "import xxx; assert xxx.works()"`
- [ ] A2: 测试全绿 — `pytest -q`
- [ ] A3: lint — `ruff check .`
- [ ] A4: 产物探针 — `grep -q "expected" dist/index.js`
```

**首轮**若无 `ACCEPTANCE.md`:你据 `GOAL.md` **提议**一份,写入,STATE 标注"待用户确认"。确认前可先按它推进(原则4),但**循环中不得为通过而修改它**(那是作弊)。

---

## 7. Automations — 触发器(支柱1)

核心约定:**触发器只负责唤醒,不指定目标。** agent 被唤醒后自己扫描发现活(§4.0)。这把你原则1原话——"让它自己去发现该干的活"——直接落到机制上。

### 7.1 唤醒信号约定
所有触发器统一动作:写 `.loop/WAKE.flag`(内容=时间戳+来源)。**消费者二选一**(缝1):(推荐)`run-loop -Watch` 前台常驻,默认每 60s 消费一次——commit/PR 后秒级响应,不用等定时器;或定时器周期性调 `run-loop -Guard` 消费(适合无人值守机器)。跑完删 flag。

### 7.2 三类触发器(配套脚本在 `triggers/`)

**(a) 定时触发** — 装一次,周期性唤醒:
- Windows:`install-scheduled.ps1` 注册 Task Scheduler(默认每 30 分钟)。
- Linux/mac:`install-scheduled.sh` 注册 cron 或 systemd user timer。

适合守护模式(扫主分支健康、PR 响应、覆盖率)。

**(b) commit 触发** — git hook,提交后唤醒:
- `triggers/post-commit`(bash)/ 安装到 `.git/hooks/post-commit`。
- hook **必须快**:只 `touch .loop/WAKE.flag` 然后立即返回,绝不在 hook 里跑长循环(那是 run-loop 的事,由定时器消费)。

适合"每次提交后自检、修回归"。

**(c) PR 触发** — 轮询(定时任务里跑):
- 定时任务调用 `triggers/scan-prs`(脚本),`gh pr list --state open --json ...` 发现新 PR 或 CI 红 → 写 `inbox/<ts>.json` + `WAKE.flag`。

适合"PR 自动响应"。

### 7.3 守护模式的运行节奏
```
[定时器/commit/PR] → touch WAKE.flag → [run-loop 消费] → SCAN 发现活 → 干一轮 → 更新 STATE → 删 WAKE.flag → 等下次唤醒
```
永不停(守护模式没有 DONE,只有 IDLE/PARKED)。人类只读 digest。

---

## 8. Worktrees — 并行隔离(支柱3)

**铁律:agent 永远不在主工作树跑。** 每个任务一个独立 worktree + 独立分支,多个 agent 并行也互不打架。

### 8.1 开 worktree(每个任务)
```bash
# 在主仓库根目录
TASK_ID="loop-$(date +%s)"
git worktree add "../<repo>-${TASK_ID}" -b "loop/${TASK_ID}"
cd "../<repo>-${TASK_ID}"
# 把 .loop/ 建在这个 worktree 里(随分支走),或用中央 .loop/<task-id>/
```

### 8.2 约定
- `.loop/` 放 worktree 内:状态随分支走,删 worktree 前先把 `STATE.md`/`HISTORY.md` 归档到中央 `.loop-archive/<task-id>/`。
- 并行任务:N 个 worktree = N 个 agent 同时跑,各自分支,绝不共享工作树。
- `run-loop -TaskId <id>`:worktree 不存在时**自动 `git worktree add`** 创建 + 切到 `../<repo>-<taskid>`(分支 `loop/<id>`);已存在则直接切。这是缝3 的落地——真正"每个任务自动开隔离环境",无需手动建树。
- 收尾:成功 → push 分支/开 PR(由 host,非 sandbox,这里没沙箱所以直接做);失败 → `git worktree remove --force` + 归档 STATE。
- 周期性清理:`git worktree prune`(写进定时任务)。

### 8.3 中央调度(多任务)
守护模式下,`inbox/*.json` 是任务队列。`run-loop` 可加 `-DrainQueue`:扫描 inbox,为每个待办开一个 worktree 跑(受 `MAX_PARALLEL` 限制,默认 2)。

---

## 9. PARKED 与归档

达 `MAX_ITERS`、预算、或振荡(同一问题修 3 轮没进展 / 同一验收 flip 3 次):

1. 写 `.loop/PARKED.flag`:
   ```markdown
   # PARKED — <原因>
   - 已尝试轮次: N
   - 卡在: <具体,引用 文件:行号>
   - 已完成: <概要,别浪费>
   - 建议(给人类): <1-3 条具体可操作建议>
   - 归档: HISTORY.md + iter-N/
   ```
2. 停止。park 是合法结局,不是失败。
3. 守护模式:PARKED 仅针对单个 inbox 任务,不影响其他任务/后续唤醒。

---

## 10. 第一轮启动清单(给 AI)

进入第 1 轮前,依次确认(缺什么补什么,别问):

- [ ] `.loop/` 存在?否则创建。
- [ ] `GOAL.md` 非空?读它。判断:单目标 还是 守护模式?
- [ ] `ACCEPTANCE.md` 非空?若否,据 GOAL 提议(§6),STATE 标注待确认。
- [ ] `skills/` 三件套(CONVENTIONS/COMMANDS/PITFALLS)存在?若否,扫仓库自动生成初稿(COMMANDS 从 package.json/Makefile 等推断),STATE 标注"AI 生成的 skills,待用户复核"。
- [ ] `STATE.md` 存在?若否,按 §5 创建第 0 轮(已完成=空,下一步=分析 GOAL 拆解)。
- [ ] 在 git 仓库?是 → 准备 worktree(§8)。
- [ ] `MAX_ITERS` 确认(默认 12,守护模式可设更高或不设)。
- [ ] 守护模式 → 记录 `last-scan.sha = git rev-parse HEAD`。

然后进入 `SCAN → PLAN → DO → REVIEW → CHECK → ACT`。

---

## 11. 默认参数(可在 STATE.md 头部覆盖)

| 参数 | 默认 | 说明 |
|---|---|---|
| `MAX_ITERS` | 12 | 单目标任务硬上限。守护模式可不设(靠唤醒节奏)。 |
| `MAX_REVIEW_RETRIES/轮` | 3 | 单轮 REVIEW→DO 小循环上限。 |
| 振荡阈值 | 3 轮 | 连续 3 轮无实质进展提前 park。 |
| `MAX_PARALLEL` | 2 | 守护模式并行 worktree 数。 |
| 高危路径 | `**/secrets/**`,`**/migrations/**`,`**/.github/**`,`**/*.env*` | 默认只读,改动需 STATE 明确理由。 |

---

## 附录 A — REVIEW 子代理 Prompt 模板(支柱5)

调用 `Task` 工具(只读探索型子代理,优先 opus):

```
你是对抗式审查者(COUNTER-REVIEWER)。你没写这段代码,任务是挑刺,不是表扬。

目标(GOAL):<粘贴 GOAL.md 一句话>
本轮改动:git diff HEAD~1..HEAD(非 git 仓库则列出修改文件路径)
验收清单:<粘贴 ACCEPTANCE.md>
项目约定:<粘贴 skills/CONVENTIONS.md 要点>

规则:
- 只能用 Read / Grep / Glob 和只读 git(diff/log/show)。禁止写文件、禁止 commit/push。
- 判断:改动真的推进目标了吗?有回归吗?有更简单/正确的做法吗?碰了不该碰的高危路径吗?删了测试或改了验收来通过吗?符合 CONVENTIONS 吗?
- 不要重跑验收命令(orchestrator 会跑),只评审设计与正确性。

最后一行必须且只能是:
VERDICT: APPROVE
或
VERDICT: REJECT: <具体理由,引用 文件:行号;给可执行修复方向>
```

---

## 附录 B — 六大原则遵守自查表(每轮 ACT 前默念)

| 支柱 | 本轮做到了吗? |
|---|---|
| 1 Automations | (守护)SCAN 扫了?WAKE.flag 消费了? |
| 2 Memory | STATE.md 重写了?失忆同事能接手? |
| 3 Worktrees | 在独立 worktree 跑,没碰主树? |
| 4 Skills | 读了三件套?新坑记进 PITFALLS? |
| 5 Evaluator | 用了独立只读子代理审?没自查蒙混? |
| 6 Hard Stop | DONE 三条件(验收+质量门+CI)齐了才结束? |
| 自我文档 | 本轮有值得记的问题/决策,写进 DEVLOG 了?(非每轮写) |

---

## 附录 C — 与历史设计(v1~vfinal)的关系

本协议提炼自六版迭代的核心思想:
- **保留**:exit code 决定退出(支柱6)、权力分离(支柱5)、失忆+STATE(支柱2/支柱4 Memory+Skills)、worktree 隔离(支柱3)、触发器投递(支柱1)、不阻塞人类(原则4)、证据驱动(振荡检测/park/IDLE)。
- **抛弃**:farmd/SQLite/Docker 沙箱/Envoy 代理/自动晋升/仲裁器/DAG/...—— 这些是"软件系统工程",不是"loop 文档"。Claude Code 自带工具集已是 orchestrator;真正无人值守时,触发器 + 20 行 `run-loop` 就够。
- **极简化触发器**:历史设计的 webhook 服务器/队列目录系统,简化为"信号文件 + 定时消费 + agent 自己扫描"。

记住 v5 的告诫:**下一篇产出不该是 LOOP v2,而该是 `.loop/HISTORY.md` 里有真实轮次记录。先跑起来。**
