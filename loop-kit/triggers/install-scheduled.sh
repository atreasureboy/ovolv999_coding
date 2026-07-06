#!/usr/bin/env bash
# install-scheduled.sh — 注册定时任务,周期性唤醒 agent(LOOP 支柱1)
# 守护模式用:装一次,每 N 分钟跑一轮 SCAN。
# 优先 systemd user timer(fallback cron)。用法:
#   ./install-scheduled.sh              # 默认每 30 分钟
#   ./install-scheduled.sh 15           # 每 15 分钟
#   ./install-scheduled.sh uninstall

set -euo pipefail
EVERY="${1:-30}"
PROJECT_ROOT="$(pwd)"
RUN_LOOP="$PROJECT_ROOT/run-loop.sh"

if [ ! -f "$RUN_LOOP" ]; then
  echo "[loop] 找不到 $RUN_LOOP。请在项目根(含 loop-kit 内容)运行此脚本。" >&2
  exit 1
fi
chmod +x "$RUN_LOOP" 2>/dev/null || true

if [ "${1:-}" = "uninstall" ]; then
  if command -v systemctl >/dev/null 2>&1 && systemctl --user list-unit-files 2>/dev/null | grep -q loop-guard; then
    systemctl --user disable --now loop-guard.timer 2>/dev/null || true
    rm -f ~/.config/systemd/user/loop-guard.{service,timer}
    systemctl --user daemon-reload
    echo "[loop] 已卸载 systemd timer"
  else
    crontab -l 2>/dev/null | grep -v 'run-loop.sh -Guard' | crontab - || true
    echo "[loop] 已从 crontab 移除(若存在)"
  fi
  exit 0
fi

# 检查 linger(systemd user timer 需要它才能在未登录时跑)
if command -v loginctl >/dev/null 2>&1; then
  if ! loginctl show-user "$USER" 2>/dev/null | grep -q '^Linger=yes'; then
    echo "[loop] 提示:建议运行 'sudo loginctl enable-linger $USER' 以便定时任务在未登录时也跑" >&2
  fi
fi

if command -v systemctl >/dev/null 2>&1; then
  mkdir -p ~/.config/systemd/user
  cat > ~/.config/systemd/user/loop-guard.service <<EOF
[Unit]
Description=loop guard scan
[Service]
Type=oneshot
ExecStart=$RUN_LOOP -Guard -TaskId guard
WorkingDirectory=$PROJECT_ROOT
EOF
  cat > ~/.config/systemd/user/loop-guard.timer <<EOF
[Unit]
Description=loop guard timer (every ${EVERY} min)
[Timer]
OnBootSec=1min
OnUnitActiveSec=${EVERY}min
Persistent=true
[Install]
WantedBy=timers.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now loop-guard.timer
  echo "[loop] 已注册 systemd user timer:每 ${EVERY} 分钟一轮守护 SCAN"
  echo "[loop] 查看: systemctl --user list-timers loop-guard.timer"
else
  LINE="*/${EVERY} * * * * cd $PROJECT_ROOT && $RUN_LOOP -Guard -TaskId guard >> $PROJECT_ROOT/.loop/driver-logs/cron.log 2>&1"
  ( crontab -l 2>/dev/null | grep -v 'run-loop.sh -Guard'; echo "$LINE" ) | crontab -
  echo "[loop] 已注册 crontab:每 ${EVERY} 分钟一轮"
fi
echo "[loop] 卸载: ./install-scheduled.sh uninstall"
