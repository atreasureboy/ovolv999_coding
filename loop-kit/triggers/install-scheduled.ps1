# install-scheduled.ps1 — 注册 Windows 定时任务,周期性唤醒 agent(LOOP 支柱1)
# 守护模式用:装一次,每 N 分钟跑一轮 SCAN,自己发现活。
# 用法:
#   .\install-scheduled.ps1                 # 默认每 30 分钟
#   .\install-scheduled.ps1 -EveryMinutes 15
#   .\install-scheduled.ps1 -Uninstall
#
# 它注册一个 Task Scheduler 任务,反复调用 run-loop.ps1 -Guard(守护单轮模式)。
# commit 触发由 post-commit hook 设 WAKE.flag;定时任务消费它 + 主动 SCAN。

param(
    [int]$EveryMinutes = 30,
    [string]$TaskName = "loop-guard",
    [string]$ProjectRoot = (Get-Location).Path,
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "[loop] 已卸载定时任务 '$TaskName'" -ForegroundColor Green
    } else {
        Write-Host "[loop] 定时任务 '$TaskName' 不存在" -ForegroundColor Yellow
    }
    return
}

$runLoop = Join-Path $ProjectRoot "run-loop.ps1"
if (-not (Test-Path $runLoop)) {
    Write-Host "[loop] 找不到 $runLoop。请在项目根(含 loop-kit 内容)运行此脚本。" -ForegroundColor Red
    exit 1
}

$claudeBin = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $claudeBin) {
    Write-Host "[loop] 警告:找不到 claude,任务仍会注册,但运行时会失败。请先装 Claude Code。" -ForegroundColor Yellow
}

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runLoop`" -Guard -TaskId guard"

$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes)

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable -DontStopOnIdleEnd -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

Register-ScheduledTask -TaskName $TaskName `
    -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "[loop] 已注册定时任务 '$TaskName':每 $EveryMinutes 分钟跑一轮守护 SCAN" -ForegroundColor Green
Write-Host "[loop] 项目根: $ProjectRoot" -ForegroundColor DarkGray
Write-Host "[loop] 卸载: .\install-scheduled.ps1 -Uninstall" -ForegroundColor DarkGray
