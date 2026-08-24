<#
.SYNOPSIS
    ติดตั้งและตั้งค่าให้ระบบตรวจโค้ดทำงานเองอัตโนมัติ — รันครั้งเดียวจบ

.DESCRIPTION
    1. เช็ค/ติดตั้ง Node.js
    2. npm install + ดาวน์โหลด Chromium ของ Playwright
    3. พาล็อกอินเว็บเติมโค้ดของแต่ละเกม (คุณพิมพ์รหัสผ่านเอง สคริปต์ไม่แตะ)
    4. ตั้ง Task Scheduler ให้ดึงชีท + ตรวจโค้ดใหม่เองทุกวัน

    รันซ้ำได้เรื่อย ๆ ขั้นที่ทำไว้แล้วจะถูกข้าม

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\Setup.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\Setup.ps1 -SkipLogin
#>
[CmdletBinding()]
param(
    [string]$At = '10:00',
    [int]$EveryMinutes = 60,
    [switch]$SkipLogin,
    [switch]$SkipSchedule
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir   = Split-Path -Parent $ScriptDir
$RedeemDir = Join-Path $RootDir 'redeem'

function Step { param([string]$Text) Write-Host "`n=== $Text" -ForegroundColor Cyan }
function Ok   { param([string]$Text) Write-Host "  OK  $Text" -ForegroundColor Green }
function Warn { param([string]$Text) Write-Host "  !!  $Text" -ForegroundColor Yellow }

# PATH ของ Node เพิ่งถูกเขียนตอนติดตั้ง shell เดิมยังไม่เห็น ต้องอ่านใหม่จาก registry
function Sync-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path', 'User')
}

# ---------------------------------------------------------------- 1. Node.js

Step 'Node.js'
Sync-Path
if (Get-Command node -ErrorAction SilentlyContinue) {
    Ok "มีอยู่แล้ว $(node -v)"
} else {
    Warn 'ยังไม่มี Node.js — กำลังติดตั้งผ่าน winget (จะมีหน้าต่างขออนุญาต admin)'
    winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --disable-interactivity
    Sync-Path
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw 'ติดตั้ง Node.js ไม่สำเร็จ — ลองติดตั้งเองจาก https://nodejs.org แล้วรันสคริปต์นี้ใหม่'
    }
    Ok "ติดตั้งแล้ว $(node -v)"
}

# ------------------------------------------------------- 2. Playwright + Chromium

Step 'Playwright + Chromium'
Push-Location $RedeemDir
try {
    if (Test-Path 'node_modules\playwright') {
        Ok 'ติดตั้ง package ไว้แล้ว'
    } else {
        & npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install ล้มเหลว (exit $LASTEXITCODE)" }
        Ok 'npm install เรียบร้อย'
    }
    & npx playwright install chromium | Out-Null
    Ok 'Chromium พร้อมใช้'
} finally { Pop-Location }

# ---------------------------------------------------------------- 3. ล็อกอิน

$games = (Get-Content -Raw (Join-Path $RootDir 'config\sources.json') -Encoding UTF8 | ConvertFrom-Json).games |
    Where-Object { $_.redeem -and $_.redeem.url }

Step 'ล็อกอินเว็บเติมโค้ด'
if ($SkipLogin) {
    Warn 'ข้ามตามที่สั่ง (-SkipLogin)'
} else {
    foreach ($g in $games) {
        $authFile = Join-Path $RedeemDir ('auth\{0}.json' -f $g.id)
        $profile  = Join-Path $RedeemDir ('profile\{0}' -f $g.id)
        # Zone4 อยู่หลังด่านตรวจบอท ต้องใช้โปรไฟล์ถาวรถึงจะจำการผ่านด่านไว้ได้
        $useProfile = ($g.id -eq 'zone4')

        if ((-not $useProfile -and (Test-Path $authFile)) -or ($useProfile -and (Test-Path $profile))) {
            Ok "$($g.name) — ล็อกอินไว้แล้ว"
            continue
        }

        Write-Host "`n  $($g.name) — $($g.redeem.url)" -ForegroundColor White
        Write-Host '  เบราว์เซอร์จะเปิดขึ้นมา ให้ล็อกอินเอง (รหัสผ่าน/CAPTCHA คุณทำเอง) เสร็จแล้วกด Enter ในหน้าต่างนี้'
        $ans = Read-Host '  ทำเลยไหม? [Y/n/s=ข้ามเกมนี้]'
        if ($ans -match '^(n|s)') { Warn "ข้าม $($g.name) — ระบบจะยังตรวจเกมนี้ไม่ได้"; continue }

        Push-Location $RedeemDir
        try {
            if ($useProfile) { & node login.mjs $g.id --profile } else { & node login.mjs $g.id }
        } finally { Pop-Location }

        if ((-not $useProfile -and (Test-Path $authFile)) -or ($useProfile -and (Test-Path $profile))) {
            Ok "$($g.name) — เก็บ session แล้ว"
        } else {
            Warn "$($g.name) — ยังไม่ได้ session ลองใหม่ด้วย: node login.mjs $($g.id)"
        }
    }
}

# ------------------------------------------------------------ 4. ตั้งเวลารันเอง

Step 'ตั้งให้รันเองอัตโนมัติ'
if ($SkipSchedule) {
    Warn 'ข้ามตามที่สั่ง (-SkipSchedule)'
} else {
    & powershell -ExecutionPolicy Bypass -NoProfile `
        -File (Join-Path $ScriptDir 'Register-DailyTask.ps1') -At $At -EveryMinutes $EveryMinutes
}

# ------------------------------------------------------------------ 5. ซ้อม

Step 'ทดสอบแบบซ้อม (ไม่กดยืนยัน ไม่เผาโค้ด)'
Push-Location $RedeemDir
try { & node run.mjs } finally { Pop-Location }

Write-Host "`n=== พร้อมใช้แล้ว ===" -ForegroundColor Green
Write-Host 'ถ้าซ้อมผ่านหมด สั่งตรวจจริงรอบแรกได้เลย (เริ่มโค้ดเดียวก่อน):'
Write-Host '  cd redeem; node run.mjs --game=cabal-pc --commit --limit=1' -ForegroundColor White
Write-Host 'จากนั้นระบบจะตรวจเองตามเวลาที่ตั้งไว้ — ดูสถานะได้ที่หน้า dashboard'
