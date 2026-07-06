#!/usr/bin/env bash
# scan-prs.sh — 扫描开放 PR,发现需处理的就唤醒 agent(LOOP 支柱1)
# 用法: ./scan-prs.sh you/repo
# 前置:gh 已认证。
set -euo pipefail
REPO="${1:?用法: $0 <owner/repo>}"
PROJECT_ROOT="$(pwd)"
LOOP_DIR="$PROJECT_ROOT/.loop"
INBOX="$LOOP_DIR/inbox"
mkdir -p "$INBOX"

if ! command -v gh >/dev/null 2>&1; then
  echo "[scan-prs] gh 未安装/未认证" >&2; exit 1
fi

PRS=$(gh pr list --repo "$REPO" --state open \
  --json number,title,headRefName,reviewDecision,statusCheckRollup 2>/dev/null || echo "[]")
COUNT=$(printf '%s' "$PRS" | jq 'length')
if [ "$COUNT" = "0" ]; then echo "[scan-prs] 无开放 PR"; exit 0; fi

for i in $(seq 0 $((COUNT-1))); do
  PR=$(printf '%s' "$PRS" | jq ".[$i]")
  NUM=$(printf '%s' "$PR" | jq -r .number)
  TITLE=$(printf '%s' "$PR" | jq -r .title)
  HEAD=$(printf '%s' "$PR" | jq -r .headRefName)
  DECISION=$(printf '%s' "$PR" | jq -r .reviewDecision)
  RED=$(printf '%s' "$PR" | jq '[.statusCheckRollup[]? | select(.conclusion=="FAILURE" or .conclusion=="CANCELLED")] | length')

  REASONS=""
  [ "$RED" != "0" ] && REASONS="CI red"
  [ "$DECISION" = "CHANGES_REQUESTED" ] && REASONS="${REASONS:+$REASONS, }changes requested"

  if [ -n "$REASONS" ]; then
    TS=$(date +%s)
    GOAL="处理 PR #$NUM ($TITLE): $REASONS。checkout 分支 $HEAD,修复让 CI 绿、满足 review。"
    jq -nc --arg ts "$TS" --argjson pr "$NUM" --arg g "$GOAL" \
      '{ts:$ts,src:"pr",pr:$pr,goal:$g}' > "$INBOX/pr-$NUM-$TS.json"
    printf '{"ts":"%s","src":"pr","pr":%s}' "$(date -u +%FT%TZ)" "$NUM" > "$LOOP_DIR/WAKE.flag"
    echo "[scan-prs] PR #$NUM 需处理 → inbox/pr-$NUM-$TS.json"
  fi
done
echo "[scan-prs] 扫描完成"
