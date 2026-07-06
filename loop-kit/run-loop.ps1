# run-loop.ps1 — 无人值守 Loop 驱动(Windows / PowerShell) v3
# 模式:
#   单目标(默认):循环 MaxIters 轮直到 DONE/PARKED。
#       .\run-loop.ps1  |  .\run-loop.ps1 -MaxIters 20
#   守护单轮(-Guard):跑一轮就退出,供定时器反复调用。
#       .\run-loop.ps1 -Guard
#   持续守护(-Watch):前台常驻,每 WatchInterval 秒一轮,commit/PR 后秒级响应(缝1)。
#       .\run-loop.ps1 -Watch -WatchInterval 60
#   worktree 隔离(支柱3):不存在时自动 git worktree add 创建(缝3)。
#       .\run-loop.ps1 -TaskId feat-retry
#   独立评估(支柱5):指定模型时走 shell 级只读审查,可跨运营商(缝5);不指定则会话内原模型子代理审。
#       .\run-loop.ps1 -ReviewModel claude-opus-4-5
#       .\run-loop.ps1 -ReviewModel glm-4.6 -ReviewBin glmcoder   # 跨运营商
#   .\run-loop.ps1 -DryRun          # 只打印 prompt
#
# 每轮 fresh context 的 claude -p,靠 .loop\STATE.md 传递记忆(支柱2)。

param(
    [int]$MaxIters = 12,
    [int]$WatchInterval = 60,
    [string]$ClaudeBin = "claude",
    [string]$TaskId = "",
    [string]$ReviewModel = "",          # 指定 → shell 级独立只读评估(支柱5)
    [string]$ReviewBin = "",            # 评估用 CLI,默认同 ClaudeBin(可跨运营商)
    [switch]$Guard,
    [switch]$Watch,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$origCwd = (Get-Location).Path
if (-not $ReviewBin) { $ReviewBin = $ClaudeBin }

# 缝3 支柱3:自动创建 worktree(guard 不开)
if ($TaskId -and $TaskId -ne "guard") {
    $repoBase = Split-Path $origCwd -Leaf
    $wt = Join-Path (Split-Path $origCwd -Parent) "$repoBase-$TaskId"
    if (Test-Path $wt) {
        Set-Location $wt
        Write-Host "[loop] 切到 worktree: $wt" -ForegroundColor DarkGray
    } elseif (Get-Command git -ErrorAction SilentlyContinue) {
        Write-Host "[loop] 自动创建 worktree + 分支 loop/$TaskId" -ForegroundColor DarkGray
        & git -C $origCwd worktree add -b "loop/$TaskId" $wt 2>&1 | Out-Host
        if ($LASTEXITCODE -eq 0 -and (Test-Path $wt)) { Set-Location $wt }
        else { Write-Host "[loop] worktree 创建失败,当前目录跑" -ForegroundColor Yellow; $TaskId = "" }
    } else { $TaskId = "" }
}

$loopDir = ".loop"
if (-not (Test-Path $loopDir)) {
    Write-Host "[loop] 错误:找不到 $loopDir\。请先建 .loop\ 并放入 LOOP.md / GOAL.md / ACCEPTANCE.md / skills\。" -ForegroundColor Red
    Set-Location $origCwd; exit 1
}
if (-not (Test-Path "$loopDir\LOOP.md")) {
    Write-Host "[loop] 错误:找不到 $loopDir\LOOP.md" -ForegroundColor Red
    Set-Location $origCwd; exit 1
}

$logDir = "$loopDir\driver-logs"
$inbox  = "$loopDir\inbox"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
if (-not (Test-Path $inbox))  { New-Item -ItemType Directory -Path $inbox  | Out-Null }

function Invoke-OneIteration {
    param([int]$N, [bool]$IsGuard)
    # 消费 WAKE.flag(支柱1)
    $wake = ""
    if (Test-Path "$loopDir\WAKE.flag") {
        $wake = (Get-Content "$loopDir\WAKE.flag" -Raw).Trim()
        Remove-Item "$loopDir\WAKE.flag" -Force
    }
    $modeLine = if ($IsGuard) { "守护模式:执行一轮 WAKE/SCAN→(发现活则)PLAN→DO→...→ACT,然后结束本轮。无活写 .loop\IDLE.flag 退出。守护无 DONE。" } else { "单目标模式:目标是让验收全绿+质量门绿=DONE。" }
    $wakeLine = if ($wake) { "唤醒来源: $wake" } else { "(无显式唤醒;守护模式则主动扫描)" }

    # 缝5 支柱5:独立评估反馈 + 跳过会话内 REVIEW(若指定 ReviewModel)
    $evalHint = ""
    if ($ReviewModel -and (Test-Path "$loopDir\last-verdict.txt")) {
        $lv = (Get-Content "$loopDir\last-verdict.txt" -Raw).Trim()
        $evalHint = "`n[上轮独立评估($ReviewModel)verdict]`n$lv`n若含 REJECT,本轮必须修正这些项。"
    }
    $reviewLine = if ($ReviewModel) { "REVIEW:跳过(外部独立评估者 $ReviewModel 会审,你直接 DO→CHECK→ACT)。" } else { "REVIEW:用 Task 只读子代理审(原模型)。" }

    $prompt = @"
你在执行 LOOP 自主循环协议(读 .loop\LOOP.md)第 $N 轮。
$modeLine
$wakeLine
$reviewLine
$evalHint

按序读(支柱2/4):
  .loop\STATE.md(上轮到哪)→ .loop\GOAL.md → .loop\ACCEPTANCE.md → .loop\skills\CONVENTIONS.md → .loop\skills\COMMANDS.md → .loop\skills\PITFALLS.md
  .loop\inbox\*.json(守护模式:触发器投递的明确目标,有则排入待办)

执行一轮(支柱5/6):
  [守护]先 SCAN:扫 git log / gh pr list / 跑 skills\COMMANDS.md 质量门 / 查 GOAL 守护不变量 / 读 inbox,自己发现该干的活
  PLAN(TodoWrite)→ DO(真实改动,git commit)→ $reviewLine → CHECK(skills\COMMANDS.md 全部门 + ACCEPTANCE 全部条目)→ ACT

ACT 退出判定(支柱6):
  - 单目标:ACCEPTANCE 全 exit0 ∧ 质量门全绿 ∧(有CI时)CI绿 → 写 .loop\DONE.flag 停止 + DEVLOG 任务总结;否则重写 .loop\STATE.md,追加 .loop\HISTORY.md,遇坑追加 skills\PITFALLS.md,遇非平凡问题/决策追加 .loop\DEVLOG.md(格式见 LOOP §4.6,非每轮写)。
  - 守护:干完一轮就结束本轮(可写 IDLE.flag),绝不擅自写 DONE;单 inbox 任务卡住写 PARKED.flag。
原则:不中途提问、不等确认、不阻塞人类。振荡或触上限写 .loop\PARKED.flag。
"@

    if ($DryRun) {
        Write-Host "[loop] DRY-RUN prompt:`n$prompt" -ForegroundColor DarkGray
        return
    }
    & $ClaudeBin -p $prompt 2>&1 | Tee-Object -FilePath "$logDir\iter-$N.log"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[loop] 第 $N 轮 writer 退出码 $LASTEXITCODE(STATE.md 会记录,继续)" -ForegroundColor Yellow
    }

    # 缝5 支柱5:shell 级独立只读评估(指定 ReviewModel 时;可跨运营商)
    if ($ReviewModel) {
        $diff = (git diff HEAD~1..HEAD 2>$null | Select-Object -First 400 | Out-String).Trim()
        if (-not $diff) { $diff = "(本轮无 commit diff,可能仅有首建/状态文件改动)" }
        $evalPrompt = @"
你是对抗式代码审查者(LOOP 支柱5)。你没写这段代码,任务是挑刺不是表扬。
本轮 diff(HEAD~1..HEAD,截前400行):
$diff

目标见 .loop\GOAL.md;验收见 .loop\ACCEPTANCE.md;约定见 .loop\skills\CONVENTIONS.md。
判断:改动真的推进目标?有回归?更简单/正确的做法?碰了不该碰的高危路径?删测试/改验收来通过?
不要改代码。最后一行必须且只能是:
VERDICT: APPROVE
或
VERDICT: REJECT: <具体理由,引用 文件:行号;给可执行修复方向>
"@
        Write-Host "[loop] 调用独立评估者: $ReviewBin --model $ReviewModel" -ForegroundColor DarkGray
        $v = & $ReviewBin -p $evalPrompt --model $ReviewModel 2>&1 | Tee-Object -FilePath "$logDir\iter-$N-eval.log"
        ($v | Select-Object -Last 5) -join "`n" | Out-File "$loopDir\last-verdict.txt" -Encoding utf8
        Write-Host "[loop] verdict 已写入 .loop\last-verdict.txt(下一轮 writer 会读)" -ForegroundColor DarkGray
    } else {
        Remove-Item "$loopDir\last-verdict.txt" -ErrorAction SilentlyContinue
    }
}

try {
    if ($Watch) {
        # 缝1:持续前台守护,周期短(默认60s),commit/PR 后秒级响应
        Write-Host "[loop] Watch:前台持续,每 ${WatchInterval}s 一轮(消费 WAKE.flag + 主动 SCAN)。Ctrl-C 退出。" -ForegroundColor Cyan
        $n = 0
        while ($true) {
            if     (Test-Path "$loopDir\DONE.flag")   { Write-Host "[loop] DONE,退出 watch" -ForegroundColor Green;  break }
            elseif (Test-Path "$loopDir\PARKED.flag") { Write-Host "[loop] PARKED,退出 watch" -ForegroundColor Yellow; break }
            $n++
            Write-Host "`n[loop] === watch 轮 #$n ===" -ForegroundColor Cyan
            Invoke-OneIteration -N $n -IsGuard $true
            Start-Sleep -Seconds $WatchInterval
        }
    } elseif ($Guard) {
        if     (Test-Path "$loopDir\DONE.flag")   { Write-Host "[loop] 已 DONE" -ForegroundColor Green }
        elseif (Test-Path "$loopDir\PARKED.flag") { Write-Host "[loop] 已 PARKED" -ForegroundColor Yellow }
        else {
            Write-Host "`n[loop] === 守护 SCAN 轮 ===" -ForegroundColor Cyan
            Invoke-OneIteration -N 1 -IsGuard $true
        }
    } else {
        for ($i = 1; $i -le $MaxIters; $i++) {
            if     (Test-Path "$loopDir\DONE.flag")   { Write-Host "[loop] DONE — 循环成功结束" -ForegroundColor Green;  break }
            elseif (Test-Path "$loopDir\PARKED.flag") { Write-Host "[loop] PARKED — 见 $loopDir\PARKED.flag" -ForegroundColor Yellow; break }
            Write-Host "`n[loop] === Iteration $i / $MaxIters ===" -ForegroundColor Cyan
            Invoke-OneIteration -N $i -IsGuard $false
            Start-Sleep -Seconds 2
        }
        if ($i -gt $MaxIters) {
            Write-Host "[loop] 达到 MaxIters=$MaxIters 上限。若未 DONE/PARKED,检查 .loop\STATE.md。" -ForegroundColor Yellow
        }
    }
} finally {
    Set-Location $origCwd
}
