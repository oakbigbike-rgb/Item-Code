<#
.SYNOPSIS
    ตั้ง Windows Task Scheduler ให้รัน Run-DailyCheck.ps1 ทุกวัน

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\Register-DailyTask.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\Register-DailyTask.ps1 -At 14:30
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\Register-DailyTask.ps1 -Remove
#>
[CmdletBinding()]
param(
    [string]$At = '10:00',
    [string]$TaskName,
    [int]$EveryMinutes,      # ใส่เพื่อให้วนซ้ำทั้งวันทุก N นาที (เช่น 30)
    [switch]$DataOnly,       # ดึงชีทอย่างเดียว ไม่เติมโค้ด (ปลอดภัย ไม่เผาโค้ด)
    [switch]$Publish,        # ดึงชีท + สร้างหน้าเว็บที่ล็อกรหัส + push ขึ้น GitHub
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# งานดึงชีทกับงานเติมโค้ดต้องแยกกัน ไม่งั้นเผลอตั้งงานเบื้องหลังที่เผาโค้ดทิ้งโดยไม่มีคนดู
if ($Publish) {
    $Target   = Join-Path $ScriptDir 'Publish-Web.ps1'
    $Extra    = ''
    if (-not $TaskName) { $TaskName = 'ItemCode อัปเดตเว็บ' }
} elseif ($DataOnly) {
    $Target   = Join-Path $ScriptDir 'Watch-Codes.ps1'
    $Extra    = '-Once'
    if (-not $TaskName) { $TaskName = 'ItemCode ดึงโค้ดจากชีท' }
} else {
    $Target   = Join-Path $ScriptDir 'Run-DailyCheck.ps1'
    $Extra    = ''
    if (-not $TaskName) { $TaskName = 'ItemCode ตรวจโค้ดรายวัน' }
}
$Daily = $Target

if ($Remove) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "ลบงาน '$TaskName' แล้ว" -ForegroundColor Green
    return
}

if (-not (Test-Path $Daily)) { throw "ไม่พบ $Daily" }

$action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File "{0}" {1}' -f $Daily, $Extra).Trim()
$trigger = New-ScheduledTaskTrigger -Daily -At $At
if ($EveryMinutes) {
    # วนซ้ำทั้งวัน — ใช้เมื่ออยากให้ตามชีทถี่ ๆ แทนที่จะรอรอบเดียวตอนเช้า
    $trigger.Repetition = (New-ScheduledTaskTrigger -Once -At $At `
        -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes) `
        -RepetitionDuration (New-TimeSpan -Hours 23 -Minutes 55)).Repetition
}
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
    -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2)

$desc = if ($Publish)  { 'ดึงชีท + สร้างหน้าเว็บที่ล็อกรหัส + push ขึ้น GitHub Pages' }
        elseif ($DataOnly) { 'ดึงโค้ดจากชีทมาอัปเดตหน้า dashboard (ไม่เติมโค้ด)' }
        else { 'ดึงโค้ดจากชีทแล้วเติม+ตรวจโค้ดของทุกเกม' }

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Description $desc -Force | Out-Null

Write-Host ("ตั้งงาน '{0}' ให้รันทุกวันเวลา {1}{2} แล้ว" -f $TaskName, $At,
    $(if ($EveryMinutes) { " แล้ววนซ้ำทุก $EveryMinutes นาที" })) -ForegroundColor Green
Write-Host "สั่งรันทดสอบเดี๋ยวนี้: Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "ดูสถานะ: Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Host ""
Write-Host "หมายเหตุ: Zone4 อยู่หลังด่านตรวจบอท ต้องรันแบบเห็นหน้าจอ (-Profile) จึงไม่เหมาะกับงานอัตโนมัติเบื้องหลัง" -ForegroundColor Yellow
Write-Host "งานรายวันนี้จะข้าม Zone4 ไปถ้าโปรไฟล์ยังผ่านด่านไม่ได้ — ตรวจ Zone4 ด้วยมือเป็นรอบ ๆ แทน" -ForegroundColor Yellow
