<#
.SYNOPSIS
    ตัวเดียวจบ — เตรียมของที่ขาด ล็อกอินที่ยังไม่ได้ล็อกอิน แล้วปล่อยให้ระบบตรวจโค้ดเองตลอด

.DESCRIPTION
    ไล่เช็คให้ทีละอย่าง แล้วทำให้เท่าที่ทำแทนได้:
      1. Node.js มีไหม (ไม่มี = บอกคำสั่งติดตั้ง หรือใส่ -InstallNode ให้ติดตั้งเลย)
      2. npm install + playwright chromium ในโฟลเดอร์ redeem
      3. session ล็อกอินของแต่ละเกม — อันไหนยังไม่มีจะเปิดเบราว์เซอร์ให้ล็อกอินทีละเกม
         (คุณพิมพ์รหัสผ่านเอง สคริปต์ไม่แตะ)
      4. เริ่ม watcher: ดึงชีทใหม่ + ตรวจโค้ดใหม่อัตโนมัติทุก N นาที

    รันซ้ำได้เรื่อย ๆ ขั้นไหนเรียบร้อยแล้วจะข้ามไปเอง

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\Start-Auto.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\Start-Auto.ps1 -IntervalMinutes 10
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\Start-Auto.ps1 -SetupOnly
#>
[CmdletBinding()]
param(
    [int]$IntervalMinutes = 15,
    [switch]$InstallNode,     # ติดตั้ง Node.js ให้เลยผ่าน winget
    [switch]$SetupOnly        # เตรียมของอย่างเดียว ไม่เริ่ม watcher
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir   = Split-Path -Parent $ScriptDir
$RedeemDir = Join-Path $RootDir 'redeem'
$AuthDir   = Join-Path $RedeemDir 'auth'

function Step { param([string]$Text) Write-Host "`n>> $Text" -ForegroundColor Cyan }
function Ok   { param([string]$Text) Write-Host "   $Text" -ForegroundColor Green }
function Warn { param([string]$Text) Write-Host "   $Text" -ForegroundColor Yellow }
function Bad  { param([string]$Text) Write-Host "   $Text" -ForegroundColor Red }

# ---------------------------------------------------------------- 1. Node.js

Step '1/4 ตรวจ Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    if ($InstallNode) {
        Warn 'ยังไม่มี Node.js — กำลังติดตั้งผ่าน winget (อาจใช้เวลาสักครู่)'
        & winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
        # winget เพิ่ง PATH ใหม่ ต้องอ่าน PATH ใหม่ในโปรเซสนี้
        $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                    [Environment]::GetEnvironmentVariable('Path', 'User')
        $node = Get-Command node -ErrorAction SilentlyContinue
    }
    if (-not $node) {
        Bad 'ยังไม่มี Node.js — ติดตั้งก่อนแล้วรันสคริปต์นี้ใหม่:'
        Bad '    winget install OpenJS.NodeJS.LTS'
        Bad 'หรือรันสคริปต์นี้ด้วย -InstallNode ให้ติดตั้งให้เลย'
        exit 1
    }
}
Ok "พบ Node.js $(& node -v)"

# ------------------------------------------------------- 2. ติดตั้ง dependency

Step '2/4 ติดตั้ง Playwright ในโฟลเดอร์ redeem'
if (Test-Path (Join-Path $RedeemDir 'node_modules\playwright')) {
    Ok 'ติดตั้งไว้แล้ว'
} else {
    Push-Location $RedeemDir
    try {
        & npm install
        if ($LASTEXITCODE -ne 0) { Bad "npm install ล้มเหลว (exit $LASTEXITCODE)"; exit 1 }
    } finally { Pop-Location }
    Ok 'ติดตั้งเรียบร้อย'
}

# ------------------------------------------------------------- 3. ล็อกอินเกม

Step '3/4 ตรวจ session ล็อกอินของแต่ละเกม'
$config = (Get-Content -Raw -Path (Join-Path $RootDir 'config\sources.json') -Encoding UTF8) | ConvertFrom-Json
$needLogin = @()
foreach ($g in $config.games) {
    if (-not $g.redeem -or -not $g.redeem.url) { continue }

    # Zone4 อยู่หลังด่านตรวจบอท ใช้โปรไฟล์เบราว์เซอร์ถาวรแทน session ไฟล์เดียว
    if ($g.id -eq 'zone4') {
        if (Test-Path (Join-Path $RedeemDir "profile\$($g.id)")) { Ok "$($g.name): มีโปรไฟล์แล้ว" }
        else { Warn "$($g.name): ต้องล็อกอินแบบโปรไฟล์ถาวร (ทำแยกตอนท้าย)" }
        continue
    }

    if (Test-Path (Join-Path $AuthDir "$($g.id).json")) { Ok "$($g.name): มี session แล้ว" }
    else { Warn "$($g.name): ยังไม่มี session"; $needLogin += $g }
}

if ($needLogin.Count) {
    Write-Host ''
    Write-Host "ต้องล็อกอิน $($needLogin.Count) เกม — เบราว์เซอร์จะเปิดให้ทีละเกม" -ForegroundColor Yellow
    Write-Host 'คุณพิมพ์รหัสผ่านเอง สคริปต์ไม่แตะรหัสผ่านและไม่ผ่าน CAPTCHA ให้' -ForegroundColor Yellow
    Push-Location $RedeemDir
    try {
        foreach ($g in $needLogin) {
            Write-Host "`n--- ล็อกอิน $($g.name) ---" -ForegroundColor Cyan
            & node login.mjs $g.id
        }
    } finally { Pop-Location }
}

# ---------------------------------------------------------------- 4. ปล่อยรัน

Step '4/4 ซ้อมก่อนหนึ่งรอบ (กรอกฟอร์มแต่ไม่กดยืนยัน)'
Push-Location $RedeemDir
try {
    & node run.mjs --limit=1
} finally { Pop-Location }

Write-Host ''
Write-Host 'ถ้าข้างบนขึ้น "กรอกฟอร์มสำเร็จ" ครบทุกเกม แปลว่า selector และ session ใช้ได้' -ForegroundColor Green
Write-Host 'ถ้ามีเกมไหนขึ้น "ข้าม ..." ให้แก้ตามข้อความนั้นก่อน' -ForegroundColor Yellow

if ($SetupOnly) {
    Write-Host "`nเตรียมของเสร็จแล้ว (ใส่ -SetupOnly ไว้จึงยังไม่เริ่ม watcher)" -ForegroundColor Cyan
    Write-Host "เริ่มเองด้วย: powershell -ExecutionPolicy Bypass -File tools\Watch-Codes.ps1 -Check"
    return
}

Write-Host ''
$answer = Read-Host 'เริ่มตรวจอัตโนมัติเลยไหม? โค้ดที่เติมสำเร็จจะถูกใช้ไปจริง ๆ (y/N)'
if ($answer -notmatch '^(y|yes|ใช่)$') {
    Write-Host 'ยังไม่เริ่ม — เริ่มเองภายหลังด้วย:' -ForegroundColor Yellow
    Write-Host '    powershell -ExecutionPolicy Bypass -File tools\Watch-Codes.ps1 -Check'
    return
}

Step "เริ่ม watcher — ดึงชีท + ตรวจโค้ดใหม่ทุก $IntervalMinutes นาที (Ctrl+C เพื่อหยุด)"
& powershell -ExecutionPolicy Bypass -NoProfile `
    -File (Join-Path $ScriptDir 'Watch-Codes.ps1') -IntervalMinutes $IntervalMinutes -Check
