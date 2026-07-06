# scan-prs.ps1 — 扫描开放 PR,发现需处理的就唤醒 agent(LOOP 支柱1)
# 由定时任务调用(或手动跑)。检测:新 PR / CI 红 / 有人 request changes。
# 用法:.\\scan-prs.ps1 -Repo "you/repo"
# 前置:gh 已认证。

param(
    [Parameter(Mandatory=$true)][string]$Repo,
    [string]$ProjectRoot = (Get-Location).Path
)

$ErrorActionPreference = "Stop"
$loopDir = Join-Path $ProjectRoot ".loop"
$inbox   = Join-Path $loopDir "inbox"
if (-not (Test-Path $inbox)) { New-Item -ItemType Directory -Path $inbox | Out-Null }

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-Host "[scan-prs] gh 未安装/未认证" -ForegroundColor Red; exit 1
}

$prs = gh pr list --repo $Repo --state open --json number,title,headRefName,isDraft,reviewDecision,statusCheckRollup 2>$null | ConvertFrom-Json
if (-not $prs) { Write-Host "[scan-prs] 无开放 PR"; exit 0 }

foreach ($pr in $prs) {
    $needsWork = $false
    $reasons = @()

    # CI 红?
    $checks = $pr.statusCheckRollup
    if ($checks) {
        $failed = $checks | Where-Object { $_.conclusion -eq "FAILURE" -or $_.conclusion -eq "CANCELLED" }
        if ($failed) { $needsWork = $true; $reasons += "CI red" }
    }
    # 有人要求修改?
    if ($pr.reviewDecision -eq "CHANGES_REQUESTED") { $needsWork = $true; $reasons += "changes requested" }

    if ($needsWork) {
        $ts = [int64](Get-Date -UFormat %s)
        $goal = "处理 PR #$($pr.number) ($($pr.title)): $($reasons -join ', ')。checkout 分支 $($pr.headRefName),修复问题让 CI 绿、满足 review。"
        $task = @{ ts = $ts; src = "pr"; pr = $pr.number; goal = $goal } | ConvertTo-Json -Compress
        $taskFile = Join-Path $inbox "pr-$($pr.number)-$ts.json"
        $task | Out-File -FilePath $taskFile -Encoding utf8
        # 唤醒
        "{\""ts`":`"$((Get-Date).ToString('o'))`",`"src`":`"pr`",`"pr`":$($pr.number)}" | Out-File -FilePath (Join-Path $loopDir "WAKE.flag") -Encoding utf8
        Write-Host "[scan-prs] PR #$($pr.number) 需处理 → $taskFile" -ForegroundColor Yellow
    }
}
Write-Host "[scan-prs] 扫描完成"
