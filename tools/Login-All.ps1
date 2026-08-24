<#
.SYNOPSIS
    ล็อกอินเว็บเติมโค้ดให้ครบทุกเกมรวดเดียว

.DESCRIPTION
    ไล่เปิดเบราว์เซอร์ทีละเกมให้ล็อกอิน แล้วเก็บ session ไว้ใช้ตรวจโค้ดอัตโนมัติ
    รหัสผ่าน / CAPTCHA / ด่านตรวจบอท คุณทำเอง — สคริปต์ไม่แตะ

    ปกติจะข้ามเกมที่ล็อกอินไว้แล้ว ใส่ -Force เพื่อทำใหม่ทุกเกม
    (เกมที่ session หมดอายุ ให้ใช้ -Force หรือระบุ -Games เจาะจง)

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\Login-All.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\Login-All.ps1 -Games warz,zone4 -Force
#>
[CmdletBinding()]
param(
    [string[]]$Games,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir   = Split-Path -Parent $ScriptDir
$RedeemDir = Join-Path $RootDir 'redeem'

$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
            [Environment]::GetEnvironmentVariable('Path', 'User')

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'ไม่พบ Node.js — รัน tools\Setup.ps1 ก่อน'
}

$all = (Get-Content -Raw (Join-Path $RootDir 'config\sources.json') -Encoding UTF8 | ConvertFrom-Json).games |
    Where-Object { $_.redeem -and $_.redeem.url }
if ($Games) { $all = $all | Where-Object { $Games -contains $_.id } }

if (-not $all) { throw 'ไม่พบเกมที่ตรงกับที่ระบุ' }

Write-Host "จะล็อกอิน $($all.Count) เกม — เบราว์เซอร์จะเปิดทีละอัน" -ForegroundColor Cyan
Write-Host 'ล็อกอินเสร็จแล้วระบบจะรู้เองและปิดให้ (หรือกด Enter ที่หน้าต่างนี้ก็ได้)' -ForegroundColor DarkGray

$done = @(); $skipped = @(); $failed = @()

foreach ($g in $all) {
    # Zone4 อยู่หลังด่านตรวจบอท ต้องใช้โปรไฟล์ถาวรถึงจะจำการผ่านด่านไว้ได้
    $useProfile = ($g.id -eq 'zone4')
    $authFile   = Join-Path $RedeemDir ('auth\{0}.json' -f $g.id)
    $profileDir = Join-Path $RedeemDir ('profile\{0}' -f $g.id)
    $have       = if ($useProfile) { Test-Path $profileDir } else { Test-Path $authFile }

    if ($have -and -not $Force) {
        Write-Host "`n[ข้าม] $($g.name) — มี session อยู่แล้ว (ใส่ -Force ถ้าจะล็อกอินใหม่)" -ForegroundColor DarkGray
        $skipped += $g.name
        continue
    }

    Write-Host "`n=== $($g.name) — $($g.redeem.url)" -ForegroundColor Cyan
    Push-Location $RedeemDir
    try {
        if ($useProfile) { & node login.mjs $g.id --profile } else { & node login.mjs $g.id }
    } finally { Pop-Location }

    $ok = if ($useProfile) { Test-Path $profileDir } else { Test-Path $authFile }
    if ($ok) {
        Write-Host "  เก็บ session ของ $($g.name) แล้ว" -ForegroundColor Green
        $done += $g.name
    } else {
        Write-Host "  ยังไม่ได้ session ของ $($g.name)" -ForegroundColor Yellow
        $failed += $g.name
    }
}

Write-Host "`n=== สรุป ===" -ForegroundColor Cyan
if ($done)    { Write-Host ("ล็อกอินแล้ว : " + ($done -join ', ')) -ForegroundColor Green }
if ($skipped) { Write-Host ("ข้ามไป      : " + ($skipped -join ', ')) -ForegroundColor DarkGray }
if ($failed)  { Write-Host ("ยังไม่สำเร็จ : " + ($failed -join ', ')) -ForegroundColor Yellow }

Write-Host "`nเช็คว่าใช้ได้จริงไหม (โหมดซ้อม ไม่เผาโค้ด):"
Write-Host '  cd redeem; node run.mjs' -ForegroundColor White
