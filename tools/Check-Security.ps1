<#
.SYNOPSIS
    ตรวจว่าข้อมูลลับของโปรเจกต์นี้รั่วออกไปทางไหนได้บ้าง

.DESCRIPTION
    ไล่เช็คของที่ "หลุดแล้วเดือดร้อน" 4 อย่าง
      1. session ล็อกอินเกม (redeem\auth, redeem\profile) — หลุด = เข้าบัญชีได้เลย
      2. ไฟล์ที่เอาไว้แชร์ (share\) — มีโค้ดจริงฝังอยู่ไหม
      3. เซิร์ฟเวอร์ที่เปิด — เปิดให้คนนอกเครื่องเข้าได้หรือเปล่า
      4. .gitignore — ของลับถูกกันไม่ให้ commit ครบไหม

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\Check-Security.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\Check-Security.ps1 -Fix
#>
[CmdletBinding()]
param([switch]$Fix)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root      = Split-Path -Parent $ScriptDir

$issues = 0
function Pass { param([string]$m) Write-Host "  [ok]   $m" -ForegroundColor Green }
function Warn { param([string]$m) $script:issues++; Write-Host "  [เสี่ยง] $m" -ForegroundColor Yellow }
function Bad  { param([string]$m) $script:issues++; Write-Host "  [อันตราย] $m" -ForegroundColor Red }
function Note { param([string]$m) Write-Host "         $m" -ForegroundColor DarkGray }

Write-Host "`n=== 1. session ล็อกอินเกม ===" -ForegroundColor Cyan

$secretPaths = @(
    @{ Path = 'redeem\auth';    Desc = 'cookie ล็อกอินของแต่ละเกม' },
    @{ Path = 'redeem\profile'; Desc = 'โปรไฟล์เบราว์เซอร์ที่ล็อกอินค้างไว้' }
)
foreach ($s in $secretPaths) {
    $full = Join-Path $Root $s.Path
    if (-not (Test-Path $full)) { Pass "$($s.Path) — ยังไม่มี"; continue }

    $acl = Get-Acl $full
    # ผู้ดูแลระบบยึดสิทธิ์เอาเองได้เสมอ จึงไม่นับเป็นช่องโหว่ แค่บอกให้รู้
    $others = $acl.Access | Where-Object {
        $_.IdentityReference -notmatch [regex]::Escape($env:USERNAME) -and
        $_.IdentityReference -notmatch 'NT AUTHORITY\\SYSTEM' -and
        $_.IdentityReference -notmatch 'BUILTIN\\Administrators'
    }
    $hasAdmin = $acl.Access | Where-Object { $_.IdentityReference -match 'BUILTIN\\Administrators' }

    if ($others) {
        Warn "$($s.Path) — บัญชีอื่นในเครื่องอ่านได้: $(($others.IdentityReference | Select-Object -Unique) -join ', ')"
        Note "$($s.Desc) — หลุดแล้วเข้าบัญชีเกมได้ทันทีโดยไม่ต้องใช้รหัสผ่าน"
        if ($Fix) {
            & icacls $full /inheritance:r /grant "$($env:USERNAME):(OI)(CI)F" /grant 'SYSTEM:(OI)(CI)F' /T /Q | Out-Null
            & icacls $full /remove:g 'BUILTIN\Administrators' /T /Q | Out-Null
            Note 'แก้แล้ว: จำกัดให้เฉพาะบัญชีคุณกับ SYSTEM'
        }
    } else {
        Pass "$($s.Path) — จำกัดให้เฉพาะบัญชีคุณแล้ว"
        if ($hasAdmin) { Note 'บัญชีผู้ดูแลระบบยังเข้าถึงได้ — เป็นเรื่องปกติของ Windows ปิดไม่ได้จริง' }
    }
}
if (-not $Fix -and $issues -gt 0) { Note 'ใส่ -Fix เพื่อให้จำกัดสิทธิ์ให้อัตโนมัติ' }

Write-Host "`n=== 2. ไฟล์ที่เอาไว้แชร์ ===" -ForegroundColor Cyan

$shareDir = Join-Path $Root 'share'
if (-not (Test-Path $shareDir)) {
    Pass 'ยังไม่มีโฟลเดอร์ share'
} else {
    foreach ($f in Get-ChildItem $shareDir -File) {
        $text = [IO.File]::ReadAllText($f.FullName)
        $hits = [regex]::Matches($text, '"code":"[A-Z0-9][A-Z0-9\-]{5,}"').Count
        if ($hits -gt 0) {
            Warn "$($f.Name) — มีโค้ดจริง $hits ตัวฝังอยู่ในไฟล์ (ตั้งใจไว้แบบนี้)"
            Note 'ใครเปิดไฟล์หรือลิงก์นี้ได้ ก็ก็อปโค้ดไปเติมได้ทุกตัว และลิงก์ถูกส่งต่อได้โดยเราไม่รู้'
            Note 'ถ้าต้องให้คนนอกทีมดู สร้างอีกไฟล์แบบปิดบังโค้ด: node tools\build-share.mjs --mask'
        } else {
            Pass "$($f.Name) — ไม่มีโค้ดจริงอยู่ในไฟล์"
        }
    }
}

Write-Host "`n=== 3. เซิร์ฟเวอร์ ===" -ForegroundColor Cyan

$serve = Get-Content (Join-Path $Root 'tools\Serve.ps1') -Raw -Encoding UTF8
if ($serve -match 'Prefixes\.Add\("http://127\.0\.0\.1') {
    Pass 'Serve.ps1 ผูกกับ 127.0.0.1 ตรง ๆ — เครื่องอื่นเข้าไม่ได้'
} elseif ($serve -match 'Prefixes\.Add\("http://localhost') {
    Warn 'Serve.ps1 ใช้คำว่า localhost — ควรระบุ 127.0.0.1 ตรง ๆ จะชัดเจนกว่า'
} else {
    Warn 'อ่านการตั้งค่า Serve.ps1 ไม่ออก ตรวจด้วยตาอีกที'
}

# ต้องเทียบแบบตรงตัว — "::1" คือ loopback ของ IPv6 ส่วน "::" คือทุกอินเทอร์เฟซ คนละเรื่องกัน
$listening = Get-NetTCPConnection -State Listen -LocalPort 4173 -ErrorAction SilentlyContinue
if ($listening) {
    $open = $listening | Where-Object { $_.LocalAddress -eq '0.0.0.0' -or $_.LocalAddress -eq '::' }
    if ($open) {
        Warn "พอร์ต 4173 ผูกกับทุกอินเทอร์เฟซ ($(($open.LocalAddress | Select-Object -Unique) -join ', '))"
        Note 'ถ้าเป็นเซิร์ฟเวอร์ที่รันจาก Serve.ps1 แบบปกติ HTTP.sys จะรับเฉพาะคำขอที่ส่งมาหา localhost'
        Note 'แต่ถ้าไม่แน่ใจว่าเป็นตัวไหน ให้ปิดแล้วเปิดใหม่ด้วย tools\Serve.ps1'
    } else {
        Pass "พอร์ต 4173 เปิดอยู่ที่ $(($listening.LocalAddress | Select-Object -Unique) -join ', ') เท่านั้น"
    }
} else {
    Pass 'ตอนนี้ไม่มีเซิร์ฟเวอร์เปิดค้างที่พอร์ต 4173'
}

Write-Host "`n=== 4. .gitignore ===" -ForegroundColor Cyan

$giPath = Join-Path $Root '.gitignore'
$must = @('redeem/auth/', 'redeem/profile/', 'redeem/results.json', 'redeem/shots/', 'logs/')
if (-not (Test-Path $giPath)) {
    Bad 'ไม่มี .gitignore — ถ้า push ขึ้น git จะพา session ล็อกอินไปด้วย'
} else {
    $gi = Get-Content $giPath -Raw -Encoding UTF8
    $missing = $must | Where-Object { $gi -notmatch [regex]::Escape($_) }
    if ($missing) { Warn "ยังไม่ได้กันไว้: $($missing -join ', ')" }
    else { Pass 'กันของลับไม่ให้ commit ครบแล้ว' }
    if ($gi -notmatch 'share/') {
        Warn 'โฟลเดอร์ share/ ยังไม่ถูกกัน — ไฟล์ที่มีโค้ดจริงอาจถูก commit ขึ้น git'
    }
}

Write-Host ""
if ($issues -eq 0) {
    Write-Host 'ไม่พบจุดเสี่ยง' -ForegroundColor Green
} else {
    Write-Host "พบจุดที่ควรแก้ $issues จุด" -ForegroundColor Yellow
}
Write-Host @'

สิ่งที่ระบบนี้ป้องกันให้ไม่ได้ (ต้องระวังเอง)
  - ชีท Google ตั้งแชร์เป็น "ใครมีลิงก์ก็ดูได้" ใครได้ลิงก์ไปก็เห็นโค้ดทั้งหมด
  - ลิงก์ที่แชร์ออกไปแล้ว ส่งต่อได้เรื่อย ๆ ถอนคืนไม่ได้
  - โปรแกรมอื่นที่รันด้วยบัญชีคุณเอง อ่านไฟล์ทุกอย่างในนี้ได้หมด
'@ -ForegroundColor DarkGray
