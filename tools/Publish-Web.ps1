<#
.SYNOPSIS
    ดึงชีทล่าสุด -> สร้างหน้าเว็บที่ล็อกรหัส -> push ขึ้น GitHub Pages

.DESCRIPTION
    ใช้ตัวนี้ตัวเดียวเวลาอยากให้ลิงก์เว็บมีข้อมูลใหม่
    ไฟล์ที่ขึ้นเว็บถูกเข้ารหัสด้วย ID + รหัสผ่าน คนที่ไม่มีรหัสเปิดดูอะไรไม่ได้
    โค้ดดิบ (web\data\codes.js) กับ config\sources.json ไม่ถูก commit เพราะ repo เป็น public

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\Publish-Web.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\Publish-Web.ps1 -SkipUpdate
#>
[CmdletBinding()]
param(
    [switch]$SkipUpdate,      # ไม่ต้องดึงชีทใหม่ ใช้ข้อมูลที่มีอยู่
    [switch]$NoPush           # สร้างไฟล์อย่างเดียว ไม่ push
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root      = Split-Path -Parent $ScriptDir
$DocsDir   = Join-Path $Root 'docs'

$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
            [Environment]::GetEnvironmentVariable('Path', 'User')

function Step { param([string]$t) Write-Host "`n=== $t" -ForegroundColor Cyan }

# ---------------------------------------------------------- 1. ดึงชีทล่าสุด

if ($SkipUpdate) {
    Step 'ข้ามการดึงชีท (-SkipUpdate)'
} else {
    Step 'ดึงโค้ดจากชีท'
    & powershell -ExecutionPolicy Bypass -NoProfile -File (Join-Path $ScriptDir 'Update-Codes.ps1') |
        Select-Object -Last 3
}

# ------------------------------------------------- 2. สร้างหน้าเว็บที่ล็อกรหัส

Step 'สร้างหน้าเว็บที่ล็อกรหัส'

# งานอัตโนมัติพิมพ์รหัสเองไม่ได้ จึงอ่านจากไฟล์ที่จำกัดสิทธิ์ไว้ (ไม่ถูก commit)
$secretPath = Join-Path $Root 'config\web-secret.json'
if (-not $env:ITEMCODE_PASSWORD -and (Test-Path $secretPath)) {
    $s = Get-Content -Raw $secretPath -Encoding UTF8 | ConvertFrom-Json
    $env:ITEMCODE_ID = $s.id
    $env:ITEMCODE_PASSWORD = $s.password
    Write-Host "  ใช้ ID '$($s.id)' จาก config\web-secret.json" -ForegroundColor DarkGray
} elseif (-not $env:ITEMCODE_PASSWORD) {
    Write-Host 'ยังไม่ได้ตั้ง ID/รหัสผ่าน — สคริปต์จะถามให้ใส่' -ForegroundColor DarkGray
}
New-Item -ItemType Directory -Path $DocsDir -Force | Out-Null
$target = Join-Path $DocsDir 'index.html'

Push-Location $Root
try {
    & node tools/build-share.mjs --lock $target
    if ($LASTEXITCODE -ne 0) { throw "สร้างไฟล์ไม่สำเร็จ (exit $LASTEXITCODE)" }
} finally { Pop-Location }

# กันพลาด: ไฟล์ที่จะขึ้น public ต้องไม่มีโค้ดจริงอยู่ข้างใน
$html = [IO.File]::ReadAllText($target)
$leak = [regex]::Matches($html, '"code":"[A-Z0-9][A-Z0-9\-]{5,}"').Count
if ($leak -gt 0) { throw "หยุดก่อน — ไฟล์ที่จะขึ้นเว็บยังมีโค้ดจริง $leak ตัว" }
Write-Host "  ตรวจแล้วไม่มีโค้ดจริงในไฟล์ ($([math]::Round((Get-Item $target).Length/1KB)) KB)" -ForegroundColor Green

# ป้องกัน GitHub Pages เอา Jekyll มาประมวลผลไฟล์
$nojekyll = Join-Path $DocsDir '.nojekyll'
if (-not (Test-Path $nojekyll)) { New-Item -ItemType File -Path $nojekyll | Out-Null }

# ------------------------------------------------------------- 3. push ขึ้น git

if ($NoPush) { Step 'ข้ามการ push (-NoPush)'; return }

Step 'push ขึ้น GitHub'
Push-Location $Root
try {
    # กันพลาดซ้ำอีกชั้น: ไฟล์ต้องห้ามต้องไม่ถูก track
    # ใช้ ls-files เฉย ๆ (ไม่ใส่ --error-unmatch เพราะมันเขียน stderr เวลาไฟล์ไม่ถูก track)
    foreach ($f in @('config/sources.json', 'config/web-secret.json',
                     'web/data/codes.js', 'web/data/codes.json')) {
        $tracked = & git ls-files -- $f
        if ($tracked) { throw "หยุดก่อน — $f กำลังจะถูก push ขึ้น repo สาธารณะ" }
    }

    & git add -A
    $changed = & git status --porcelain
    if (-not $changed) {
        Write-Host '  ไม่มีอะไรเปลี่ยน ไม่ต้อง push' -ForegroundColor DarkGray
    } else {
        $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm'
        & git commit -m "อัปเดตข้อมูลโค้ด $stamp"
        & git push
        if ($LASTEXITCODE -ne 0) { throw "push ไม่สำเร็จ (exit $LASTEXITCODE)" }
        Write-Host '  push เรียบร้อย — เว็บจะอัปเดตภายใน 1-2 นาที' -ForegroundColor Green
    }
} finally { Pop-Location }
