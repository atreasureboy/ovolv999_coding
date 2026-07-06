#!/usr/bin/env bash
# run-loop.sh — 无人值守 Loop 驱动(Linux / macOS / Git Bash) v3
# 模式:
#   单目标(默认):循环 MaxIters 轮直到 DONE/PARKED。  ./run-loop.sh [12]
#   守护单轮(-Guard):跑一轮退出,供定时器调用。      ./run-loop.sh -Guard
#   持续守护(-Watch):前台常驻,每 N 秒一轮(缝1)。   ./run-loop.sh -Watch -WatchInterval 60
#   worktree(-TaskId):不存在时自动 git worktree add(缝3)。 ./run-loop.sh -TaskId feat-x
#   独立评估(-ReviewModel):指定时走 shell 级只读审查,可跨运营商(缝5)。
#       ./run-loop.sh -ReviewModel claude-opus-4-5
#       ./run-loop.sh -ReviewModel glm-4.6 -ReviewBin glmcoder
#   ./run-loop.sh -DryRun          # 只打印 prompt
#
# 每轮 fresh context claude -p,靠 .loop/STATE.md 传递记忆(支柱2)。
set -uo pipefail

MAX_ITERS=12
WATCH_INTERVAL=60
DRY_RUN=0
GUARD=0
WATCH=0
TASK_ID=""
REVIEW_MODEL=""
REVIEW_BIN=""
while [ $# -gt 0 ]; do
  case "$1" in
    -Guard)         GUARD=1; shift;;
    -Watch)         WATCH=1; shift;;
    -DryRun)        DRY_RUN=1; shift;;
    -TaskId)        TASK_ID="${2:-}"; shift 2;;
    -MaxIters)      MAX_ITERS="${2:-12}"; shift 2;;
    -WatchInterval) WATCH_INTERVAL="${2:-60}"; shift 2;;
    -ReviewModel)   REVIEW_MODEL="${2:-}"; shift 2;;
    -ReviewBin)     REVIEW_BIN="${2:-}"; shift 2;;
    -h|--help)      sed -n '2,15p' "$0"; exit 0;;
    *)              MAX_ITERS="$1"; shift;;
  esac
done

CLAUDE_BIN="${CLAUDE_BIN:-claude}"
[ -z "$REVIEW_BIN" ] && REVIEW_BIN="$CLAUDE_BIN"
ORIG_CWD="$(pwd)"

# 缝3 支柱3:自动创建 worktree
if [ -n "$TASK_ID" ] && [ "$TASK_ID" != "guard" ]; then
  REPO_BASE="$(basename "$ORIG_CWD")"
  WT="$(dirname "$ORIG_CWD")/$REPO_BASE-$TASK_ID"
  if [ -d "$WT" ]; then
    cd "$WT"; echo "[loop] 切到 worktree: $WT"
  elif command -v git >/dev/null 2>&1; then
    echo "[loop] 自动创建 worktree + 分支 loop/$TASK_ID"
    if git -C "$ORIG_CWD" worktree add -b "loop/$TASK_ID" "$WT"; then
      cd "$WT"
    else
      echo "[loop] worktree 创建失败,当前目录跑"; TASK_ID=""
    fi
  else
    echo "[loop] 无 git,当前目录跑"; TASK_ID=""
  fi
fi

LOOP_DIR=".loop"
if [ ! -d "$LOOP_DIR" ]; then
  echo "[loop] 错误:找不到 $LOOP_DIR/。请先建 .loop/ 并放入 LOOP.md / GOAL.md / ACCEPTANCE.md / skills/。" >&2
  cd "$ORIG_CWD"; exit 1
fi
if [ ! -f "$LOOP_DIR/LOOP.md" ]; then
  echo "[loop] 错误:找不到 $LOOP_DIR/LOOP.md" >&2
  cd "$ORIG_CWD"; exit 1
fi

mkdir -p "$LOOP_DIR/driver-logs" "$LOOP_DIR/inbox"

invoke_eval() {  # invoke_eval <N>  — 缝5 支柱5 shell 级独立只读评估
  local N="$1"
  [ -z "$REVIEW_MODEL" ] && { rm -f "$LOOP_DIR/last-verdict.txt"; return 0; }
  local DIFF
  DIFF="$(git diff HEAD~1..HEAD 2>/dev/null | head -400)"
  [ -z "$DIFF" ] && DIFF="(本轮无 commit diff)"
  local EP="你是对抗式代码审查者(LOOP 支柱5)。你没写这段代码,任务是挑刺不是表扬。
本轮 diff(HEAD~1..HEAD,截前400行):
$DIFF

目标见 .loop/GOAL.md;验收见 .loop/ACCEPTANCE.md;约定见 .loop/skills/CONVENTIONS.md。
判断:改动真的推进目标?有回归?更简单/正确的做法?碰了不该碰的高危路径?删测试/改验收来通过?
不要改代码。最后一行必须且只能是:
VERDICT: APPROVE
或
VERDICT: REJECT: <具体理由,引用 文件:行号;给可执行修复方向>"
  echo "[loop] 调用独立评估者: $REVIEW_BIN --model $REVIEW_MODEL"
  $REVIEW_BIN -p "$EP" --model "$REVIEW_MODEL" 2>&1 \
    | tee "$LOOP_DIR/driver-logs/iter-$N-eval.log" \
    | tail -5 > "$LOOP_DIR/last-verdict.txt"
  echo "[loop] verdict 已写入 .loop/last-verdict.txt(下一轮 writer 会读)"
}

invoke_one() {  # invoke_one <N> <is_guard>
  local N="$1" IS_GUARD="$2"
  local WAKE=""
  if [ -f "$LOOP_DIR/WAKE.flag" ]; then
    WAKE="$(cat "$LOOP_DIR/WAKE.flag")"; rm -f "$LOOP_DIR/WAKE.flag"
  fi
  local MODE WAKE_L
  if [ "$IS_GUARD" = "1" ]; then
    MODE="守护模式:执行一轮 WAKE/SCAN→(发现活则)PLAN→DO→...→ACT,然后结束本轮。无活写 .loop/IDLE.flag 退出。守护无 DONE。"
  else
    MODE="单目标模式:目标是让验收全绿+质量门绿=DONE。"
  fi
  [ -n "$WAKE" ] && WAKE_L="唤醒来源: $WAKE" || WAKE_L="(无显式唤醒;守护模式则主动扫描)"

  local EVAL_HINT="" REVIEW_L
  if [ -n "$REVIEW_MODEL" ] && [ -f "$LOOP_DIR/last-verdict.txt" ]; then
    EVAL_HINT=$'\n[上轮独立评估('"$REVIEW_MODEL"$')verdict]\n'"$(cat "$LOOP_DIR/last-verdict.txt")"$'\n若含 REJECT,本轮必须修正这些项。'
  fi
  if [ -n "$REVIEW_MODEL" ]; then
    REVIEW_L="REVIEW:跳过(外部独立评估者 $REVIEW_MODEL 会审,你直接 DO→CHECK→ACT)。"
  else
    REVIEW_L="REVIEW:用 Task 只读子代理审(原模型)。"
  fi

  local PROMPT="你在执行 LOOP 自主循环协议(读 .loop/LOOP.md)第 $N 轮。
$MODE
$WAKE_L
$REVIEW_L
$EVAL_HINT

按序读(支柱2/4):
  .loop/STATE.md(上轮到哪)→ .loop/GOAL.md → .loop/ACCEPTANCE.md → .loop/skills/CONVENTIONS.md → .loop/skills/COMMANDS.md → .loop/skills/PITFALLS.md
  .loop/inbox/*.json(守护模式:触发器投递的明确目标,有则排入待办)

执行一轮(支柱5/6):
  [守护]先 SCAN:扫 git log / gh pr list / 跑 skills/COMMANDS.md 质量门 / 查 GOAL 守护不变量 / 读 inbox,自己发现该干的活
  PLAN(TodoWrite)→ DO(真实改动,git commit)→ $REVIEW_L → CHECK(skills/COMMANDS.md 全部门 + ACCEPTANCE 全部条目)→ ACT

ACT 退出判定(支柱6):
  - 单目标:ACCEPTANCE 全 exit0 ∧ 质量门全绿 ∧(有CI时)CI绿 → 写 .loop/DONE.flag 停止 + DEVLOG 任务总结;否则重写 .loop/STATE.md,追加 .loop/HISTORY.md,遇坑追加 skills/PITFALLS.md,遇非平凡问题/决策追加 .loop/DEVLOG.md(格式见 LOOP §4.6,非每轮写)。
  - 守护:干完一轮就结束本轮(可写 IDLE.flag),绝不擅自写 DONE;单 inbox 任务卡住写 PARKED.flag。
原则:不中途提问、不等确认、不阻塞人类。振荡或触上限写 .loop/PARKED.flag。"

  if [ "$DRY_RUN" = "1" ]; then echo "[loop] DRY-RUN prompt:"; echo "$PROMPT"; return; fi
  if ! $CLAUDE_BIN -p "$PROMPT" 2>&1 | tee "$LOOP_DIR/driver-logs/iter-$N.log"; then
    echo "[loop] 第 $N 轮 writer 非零退出(STATE.md 会记录,继续)"
  fi
  invoke_eval "$N"
}

if [ "$WATCH" = "1" ]; then
  echo "[loop] Watch:前台持续,每 ${WATCH_INTERVAL}s 一轮(消费 WAKE.flag + 主动 SCAN)。Ctrl-C 退出。"
  n=0
  while true; do
    if   [ -f "$LOOP_DIR/DONE.flag" ];   then echo "[loop] DONE,退出 watch"; break; fi
    if [ -f "$LOOP_DIR/PARKED.flag" ]; then echo "[loop] PARKED,退出 watch"; break; fi
    n=$((n+1))
    echo; echo "[loop] === watch 轮 #$n ==="
    invoke_one "$n" 1
    sleep "$WATCH_INTERVAL"
  done
elif [ "$GUARD" = "1" ]; then
  if   [ -f "$LOOP_DIR/DONE.flag" ];   then echo "[loop] 已 DONE"
  elif [ -f "$LOOP_DIR/PARKED.flag" ]; then echo "[loop] 已 PARKED"
  else
    echo; echo "[loop] === 守护 SCAN 轮 ==="
    invoke_one 1 1
  fi
else
  i=0
  while [ "$i" -lt "$MAX_ITERS" ]; do
    i=$((i+1))
    if   [ -f "$LOOP_DIR/DONE.flag" ];   then echo "[loop] DONE — 循环成功结束"; break; fi
    if [ -f "$LOOP_DIR/PARKED.flag" ]; then echo "[loop] PARKED — 见 $LOOP_DIR/PARKED.flag"; break; fi
    echo; echo "[loop] === Iteration $i / $MAX_ITERS ==="
    invoke_one "$i" 0
    sleep 2
  done
  if [ "$i" -gt "$MAX_ITERS" ]; then
    echo "[loop] 达到 MaxIters=$MAX_ITERS 上限。若未 DONE/PARKED,检查 .loop/STATE.md。"
  fi
fi
cd "$ORIG_CWD"
