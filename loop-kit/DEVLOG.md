# loop-kit 开发日志(DEVLOG)

> 本文记录 loop-kit 这套 Loop 协议的设计历程:遇到的问题、怎么解决的、当时的思考、使用注意事项。
> 给以后的你看,也给接手维护的 AI 看——避免重复踩坑、避免又一次过度设计。

---

## 一、本次做了什么(一句话)

把 `loop_design_v1..vfinal` 六版"软件系统设计(farmd)"压缩回**一份可直接交给 Claude Code 执行的 Loop 协议文档 + 极简驱动脚本**,并按用户给定的六大原则做了两轮审计与修补,最终六原则全部在代码层落实。

---

## 二、遇到的问题与解决(按时间线)

### 问题 1:历史文档整体走偏——做成了"系统",不是"文档"
- **现象**:v1~vfinal 五轮迭代,把"让 AI 循环执行直到完成"的需求,演变成一个需要 Python 包(farmd)+ SQLite + Docker 沙箱 + systemd + Envoy 代理 + 仲裁器 + DAG 规划器 + 自动晋升的**企业级自主软件工程系统**。v5/vfinal 自己承认"五轮设计,零行代码,零次运行",vfinal 结尾讽刺地说"下一篇不是 v6 而是 farm.db 有数据"——但 farm.db 根本不存在。
- **根因**:每一版都在审计上一版的缺陷,审计本身催生更多机制,雪球越滚越大。**把"循环指令"错当成了"循环系统的工程实现"**。
- **解决**:做一个判断——用户要的是"一份 loop 文档给 Claude Code 读",不是"一支团队几个月的工程项目"。保留六版提炼出的**核心原则**(exit code 决定退出、权力分离、失忆+STATE、不阻塞人类),**抛弃**所有基础设施(farmd/SQLite/Docker/systemd/...)。Claude Code 自带文件读写、Bash、子代理、TodoList 工具,它本身就是 orchestrator。
- **思考**:过度工程的代价不是"多写了代码",而是**永远跑不起来**。vfinal 越完整,越没人敢动手实现。设计的终极风险是设计本身。

### 问题 2:用户给定六大原则后,三块机制完全缺失
- **现象**:用户明确列出六原则(Automations / Memory / Worktrees / Skills / Evaluator / Hard Stop)。对照初版 LOOP.md,Memory/Evaluator/Hard Stop 已覆盖,但 **Automations(只有手动 run-loop,无触发器)、Worktrees(完全没提)、Skills(只有 PITFALLS,缺 CONVENTIONS/COMMANDS)** 三块是空的。
- **根因**:第一版压缩时"抛弃"过头了——把 v1 里本来有的触发器投递、worktree 思想也一起丢了。
- **解决**:补三块——
  - Automations:`triggers/` 下 post-commit / install-scheduled / scan-prs,统一用 `WAKE.flag` 信号 + agent 自己 SCAN 发现活。
  - Worktrees:`run-loop -TaskId` + git worktree 约定。
  - Skills:`skills/{CONVENTIONS,COMMANDS,PITFALLS}.md` 三件套。
- **思考**:压缩不是无脑删,是"保留原则、换轻量载体"。原则没变,落地机制从"软件模块"变成"文件约定 + 几行脚本"。

### 问题 3:用户追问"确定符合吗"——grep 实证发现三个真实缝隙
- **现象**:如果只看 LOOP.md 文档,六原则都"写了"。但用 grep 查代码,发现:
  - **缝1**:`WAKE.flag` 有写入者(触发器),**没有独立消费者**。只装 post-commit 不装定时器 → commit 后 flag 躺着没人理。"自动唤醒"名存实亡。
  - **缝2**:`worktree add` / `-DrainQueue` **只出现在 LOOP.md 文档**,run-loop 脚本里 `-TaskId` 只切换已存在的 worktree,**不会自动创建**。"每个任务自动开隔离环境"没真正实现。
  - **缝3**:run-loop 里**没有任何 `--model`**,换模型只是 LOOP.md 的文字建议,非脚本强制。
- **根因**:文档和代码不一致——文档承诺了机制,代码没兑现。这是"设计先行、实现滞后"的典型症状。
- **解决**:
  - 缝1 → `run-loop -Watch` 前台常驻模式(默认 60s 一轮),commit/PR 后秒级响应。
  - 缝2 → `-TaskId` 在 worktree 不存在时自动 `git worktree add`。
  - 缝3 → `-ReviewModel`/`-ReviewBin`:指定时走 shell 级独立只读评估(可跨运营商);不指定则默认原模型(会话内子代理)。
- **思考**:**不该由设计者嘴说"符合",要用 grep 行号自证**。这次如果不是用户追问,三个缝会被"文档写得很好"掩盖。验证必须落到代码层,不是文档层。

### 问题 4:PowerShell 中文编码导致验证误报
- **现象**:用 PowerShell `Get-Content + -match` 检查 LOOP.md 六支柱关键词,全部报 MISSING——但文件内容其实正确。
- **根因**:Windows PowerShell 控制台默认 GBK codepage,读取 UTF-8 文件做正则匹配时编码错乱。
- **解决**:改用 grep 工具(按 UTF-8 读取),立刻 6/6 命中。
- **思考**:Windows + 中文 + PowerShell 是验证脚本的雷区。涉及中文内容的校验,优先用专门工具(grep/rg)而非 PowerShell 字符串匹配。

### 问题 5:原则5"换模型"的权衡
- **现象**:用户原则5要求"换个模型"审查。但实现上有两种路径,各有代价。
- **权衡**:
  - 指令级(LOOP.md 写"用 opus 审"):保持单会话自循环简洁,但子代理模型由 Claude Code 运行时决定,loop 文档控制不了——非强制。
  - shell 级(run-loop 拆两段,evaluator 用 `claude --model opus` 独立调):真强制、真权力分离,但破坏"单会话自循环",run-loop 变成 shell 编排器,复杂度上升。
- **解决**:问用户。用户定"**默认不换,可指定(含其他运营商)**"。于是做成可配置:`-ReviewModel` 不传 → 默认原模型会话内子代理;传 → shell 级独立调用(`-ReviewBin` 可换 GLM/GPT 等任何兼容 CLI)。
- **思考**:没有完美方案,只有匹配场景的方案。把选择权交给用户,比替他决定更诚实。

---

## 三、关键思考(给以后的设计者)

1. **设计的目标是能跑起来,不是看起来完整。** vfinal 比 v1"完整"十倍,但 v1 反而更接近可运行。一份能跑的简单协议 > 一份永远跑不起来的完美系统。

2. **证据驱动 > 想象驱动。** v4/v5 已经喊出"模块按需激活"——但那是给 farmd 写的。loop-kit 把这个思想保留为:振荡检测、PARKED 归档、PITFALLS 沉淀。需要更强机制时再加,不预建。

3. **文档会撒谎,代码不会。** 任何"它符合 X"的声明,都要能用 `grep` / 测试证实。本次三个缝就是文档撒的谎。

4. **诚实是设计的一部分。** 第一轮我说"符合",被追问后 grep 发现三个缝。承认缝隙并修补,比维护"没问题"的假象更有价值。保留一个已知限制(默认不换模型)并明说,比假装全强制更可信。

5. **权力分离是 Loop 可靠性的核心。** 写代码的不能判代码(原则5),退出不能靠自评(原则6)。这两条是防止 AI"自我感觉良好"的关键,必须落到机制,不能靠提示词自觉。

---

## 四、注意事项(使用前必读)

1. **守护模式必须装消费者。** 只装 `post-commit` hook **不会**自动响应——`WAKE.flag` 需要消费者。二选一:
   - 前台:`run-loop -Watch`(秒级响应,适合开发机常驻)
   - 后台:`install-scheduled` 装定时器(分钟级,适合无人值守服务器)
   - **只装 hook 不装消费者 = 假自动**。

2. **原则5默认不换模型。** 要让审查用更强/不同模型,**必须显式传 `-ReviewModel`**(可选 `-ReviewBin` 换运营商 CLI,需兼容 `cli -p "prompt" --model X` 调用风格)。不传 = 会话内原模型子代理审。

3. **`COMMANDS.md` 是质量门唯一来源。** 必须填**确切**的 build/test/lint 命令。这是防 AI 自己瞎编一个"测试命令"然后跑空通过的物理保障。不确定就写"跳过",别猜。

4. **`ACCEPTANCE.md` 循环中不可改。** 退出只看验收(原则6)。AI 若为通过而改验收条目 = 作弊。首轮 AI 提议的验收要你确认;一旦开跑,只能改代码,不能改考题。

5. **worktree 自动建依赖 git 仓库。** `-TaskId` 自动 `git worktree add` 需要当前目录是 git 仓库且无未提交冲突。非 git 项目会回退到当前目录跑(不隔离)。

6. **CI 绿主要在 PR/守护场景有意义。** 单目标本地任务,若无 push 到远程,就没有 CI——靠本地质量门(CONVENTIONS+COMMANDS)判定。守护/PR 模式才会跑 `gh pr checks`。

7. **Windows 中文验证用 grep,别用 PowerShell -match。** 控制台 GBK 编码会误报。校验中文内容一律 grep/rg。

8. **`.loop/` 别提交进目标仓库的主分支。** 它是 agent 的工作状态。建议加进 `.gitignore`,或只在 worktree/分支里存在。

9. **振荡 = 早停,别硬撑。** 连续 3 轮同一验收 flip 或同一 patch-id,直接 PARKED。烧满 MAX_ITERS 不解决问题,只烧钱。

10. **dry-run 先行。** 任何新目标,先 `run-loop -DryRun` 看打印的 prompt 是否合理(六支柱操作是否都在指令里),再真跑。

---

## 五、已知限制 / 未做(诚实清单)

- **没跑过真实任务。** 所有验证是 grep 级(代码存在)+ DryRun 级(prompt 合理)。真实 token 消耗、agent 行为符合度、振荡处理,都未实测。**第一个真实任务是关键验证。**
- **没有 sandbox/沙箱。** vfinal 的 Docker 隔离、egress 白名单、凭证分离——全部没有。agent 用你本机的完整权限跑(能读写文件、能联网、能用你的 git 凭证)。**这是用"简洁"换来的代价**。敏感项目慎用,或后续补 sandbox。
- **`-ReviewBin` 跨运营商假设 CLI 兼容 `cli -p "..." --model X`。** 非 claude CLI(如 glm/gpt 的 coding agent)参数风格可能不同,需用户自行适配 `-ReviewBin` 的调用约定。
- **无并发调度器。** 多任务并行靠手动开多个 `-TaskId`(各自 worktree)。v4/vfinal 的 dispatcher/fairness/预算池没有。
- **无成本追踪。** `MAX_ITERS` 是唯一硬上限,没有 `$` 预算 cap。长任务可能烧钱。

> 这些限制都是"用简洁换来的"。若实测后发现某个是真痛点,再按 vfinal 对应章节补——**证据驱动,不预建**。
