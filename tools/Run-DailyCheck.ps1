<#
.SYNOPSIS
    งานประจำวัน: ดึงโค้ดใหม่จากชีท แล้วเติม+ตรวจโค้ดของทุกเกม

.DESCRIPTION
    1. รัน Update-Codes.ps1 ดึงชีทล่าสุด
    2. รัน redeem/run.mjs เติมโค้ดที่ยังไม่เคยตรวจของทุกเกมที่ตั้งค่าไว้
    3. ผลสะสมอยู่ที่ redeem/results.json และ web/data/results.js (dashboard อ่านเอง)
    4. log เก็บไว้ที่ logs/daily-<วันที่>.log

    ต้องมี Node.js + ทำ redeem/auth ไว้แล้ว (node login.mjs <gameId>)

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\Run-DailyCheck.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\Run-DailyCheck.ps1 -DryRun
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\Run-DailyCheck.ps1 -Games zone4 -Profile
#>
[CmdletBinding()]
param(
    [string[]]$Games,
    [switch]$DryRun,        # ซ้อม ไม่กดยืนยัน
    [switch]$Profile,       # ใช้โปรไฟล์เบราว์เซอร์ถาวร (เว็บที่มีด่านตรวจบอท เช่น Zone4)
    [switch]$SkipUpdate,    # ข้ามการดึงชีทใหม่
    [int]$Limit             # จำกัดจำนวนโค้ดต่อเกม
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir   = Split-Path -Parent $ScriptDir
$RedeemDir = Join-Path $RootDir 'redeem'
$LogDir    = Join-Path $RootDir 'logs'

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$LogFile = Join-Path $LogDir ('daily-{0}.log' -f (Get-Date -Format 'yyyy-MM-dd'))

function Write-Log {
    param([string]$Message, [string]$Color = 'Gray')
    $line = '[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $Message
    Write-Host $line -ForegroundColor $Color
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

Write-Log "=== เริ่มงานประจำวัน ===" 'Cyan'

# 1) ดึงชีทล่าสุด
if ($SkipUpdate) {
    Write-Log 'ข้ามการดึงชีท (-SkipUpdate)'
} else {
    Write-Log 'ดึงโค้ดจาก Google Sheets...'
    try {
        & powershell -ExecutionPolicy Bypass -NoProfile -File (Join-Path $ScriptDir 'Update-Codes.ps1') 2>&1 |
            ForEach-Object { Add-Content -Path $LogFile -Value "    $_" -Encoding UTF8 }
        if ($LASTEXITCODE -ne 0) { throw "Update-Codes.ps1 จบด้วย exit code $LASTEXITCODE" }
        Write-Log 'ดึงชีทเรียบร้อย' 'Green'
    } catch {
        Write-Log "ดึงชีทไม่สำเร็จ: $($_.Exception.Message)" 'Red'
        exit 1
    }
}

# 2) เติม + ตรวจโค้ด
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Log 'ไม่พบ Node.js — ติดตั้งก่อนด้วย: winget install OpenJS.NodeJS.LTS' 'Red'
    Write-Log 'ตอนนี้ได้แค่ข้อมูลโค้ดใหม่ ยังตรวจเติมโค้ดไม่ได้' 'Yellow'
    exit 1
}
if (-not (Test-Path (Join-Path $RedeemDir 'node_modules'))) {
    Write-Log 'ยังไม่ได้ npm install ในโฟลเดอร์ redeem — รัน: cd redeem; npm install' 'Red'
    exit 1
}

$runArgs = @('run.mjs')
if (-not $DryRun) { $runArgs += '--commit' }
if ($Profile)     { $runArgs += '--profile' }
if ($Games)       { $runArgs += "--game=$($Games -join ',')" }
if ($Limit)       { $runArgs += "--limit=$Limit" }

Write-Log ("รัน node {0}" -f ($runArgs -join ' '))
Push-Location $RedeemDir
try {
    & node @runArgs 2>&1 | ForEach-Object {
        Write-Host $_
        Add-Content -Path $LogFile -Value "    $_" -Encoding UTF8
    }
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}

if ($code -ne 0) {
    Write-Log "redeem runner จบด้วย exit code $code" 'Red'
    exit $code
}

# 3) สรุปผลสะสม
$resultsPath = Join-Path $RedeemDir 'results.json'
if (Test-Path $resultsPath) {
    $res = (Get-Content -Raw $resultsPath -Encoding UTF8 | ConvertFrom-Json).results
    $byStatus = $res | Group-Object status | ForEach-Object { "$($_.Name) $($_.Count)" }
    Write-Log ("ผลสะสมทั้งหมด {0} โค้ด — {1}" -f $res.Count, ($byStatus -join ' · ')) 'Green'
}

Write-Log '=== จบงานประจำวัน ===' 'Cyan'
