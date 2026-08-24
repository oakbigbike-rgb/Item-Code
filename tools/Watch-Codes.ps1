<#
.SYNOPSIS
    เฝ้าชีททุกเกม ดึงข้อมูลใหม่เรื่อย ๆ และ (ถ้าสั่ง) ตรวจโค้ดใหม่ให้อัตโนมัติ

.DESCRIPTION
    วนซ้ำทุก -IntervalMinutes นาที:
      1. ดึงชีทใหม่ทั้งหมด (ชีทวันใหม่ที่เพิ่งสร้างถูกดึงเองอยู่แล้ว)
      2. เทียบกับรอบก่อน — มีชีทใหม่ / โค้ดใหม่ / โค้ดถูกแก้ไหม
      3. ถ้ามีโค้ดใหม่และใส่ -Check ไว้ จะสั่ง redeem runner ตรวจเฉพาะเกมที่มีของใหม่
      4. หน้า dashboard ที่เปิดค้างไว้จะเห็นข้อมูลใหม่เองภายในไม่กี่วินาที

    หยุดด้วย Ctrl+C

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\Watch-Codes.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\Watch-Codes.ps1 -IntervalMinutes 5 -Check
#>
[CmdletBinding()]
param(
    [int]$IntervalMinutes = 15,
    [switch]$Check,          # ตรวจโค้ดใหม่ด้วย redeem runner ทันทีที่เจอ
    [switch]$Once            # รันรอบเดียวแล้วจบ (ไว้ใช้กับ Task Scheduler)
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir   = Split-Path -Parent $ScriptDir
$DataDir   = Join-Path $RootDir 'web\data'
$RedeemDir = Join-Path $RootDir 'redeem'
$LogDir    = Join-Path $RootDir 'logs'

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

function Write-Log {
    param([string]$Message, [string]$Color = 'Gray')
    $line = '[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $Message
    Write-Host $line -ForegroundColor $Color
    Add-Content -Encoding UTF8 -Value $line `
        -Path (Join-Path $LogDir ('watch-{0}.log' -f (Get-Date -Format 'yyyy-MM-dd')))
}

Write-Log "เริ่มเฝ้าชีท — ทุก $IntervalMinutes นาที$(if ($Check) { ' + ตรวจโค้ดใหม่อัตโนมัติ' })" 'Cyan'

$round = 0
while ($true) {
    $round++
    try {
        & powershell -ExecutionPolicy Bypass -NoProfile `
            -File (Join-Path $ScriptDir 'Update-Codes.ps1') 2>&1 | Out-Null

        $changesPath = Join-Path $DataDir 'changes.json'
        $latest = $null
        if (Test-Path $changesPath) {
            $doc = (Get-Content -Raw -Path $changesPath -Encoding UTF8) | ConvertFrom-Json
            $latest = @($doc.history)[0]
        }

        $versionPath = Join-Path $DataDir 'version.json'
        $ver = if (Test-Path $versionPath) { (Get-Content -Raw -Path $versionPath -Encoding UTF8) | ConvertFrom-Json } else { $null }

        # นับว่าเป็นของใหม่เฉพาะเมื่อ changes ล่าสุดมาจากการดึงรอบนี้จริง ๆ
        $fresh = $latest -and $ver -and ($latest.at -eq $ver.generatedAt)

        if (-not $fresh) {
            Write-Log ("รอบ {0}: ไม่มีอะไรเปลี่ยน (รวม {1} โค้ด)" -f $round, $(if ($ver) { $ver.total } else { '?' }))
        } else {
            foreach ($g in $latest.games) {
                $bits = @()
                if (@($g.newSheets).Count) { $bits += "ชีทใหม่: $($g.newSheets -join ', ')" }
                if (@($g.newCodes).Count)  { $bits += "โค้ดใหม่ $(@($g.newCodes).Count)" }
                if (@($g.goneCodes).Count) { $bits += "โค้ดหายไป $(@($g.goneCodes).Count)" }
                Write-Log ("{0}: {1}" -f $g.name, ($bits -join ' · ')) 'Yellow'
                foreach ($c in @($g.newCodes | Select-Object -First 10)) {
                    Write-Log ("    + {0}  ({1} · {2})" -f $c.code, $c.date, $c.sheet) 'DarkYellow'
                }
            }

            if ($Check) {
                $withNew = @($latest.games | Where-Object { @($_.newCodes).Count })
                $node = Get-Command node -ErrorAction SilentlyContinue
                if (-not $withNew.Count) {
                    # ไม่มีโค้ดใหม่ มีแต่ชีทเปล่า — ไม่ต้องตรวจอะไร
                } elseif (-not $node) {
                    Write-Log 'มีโค้ดใหม่แต่ยังไม่มี Node.js — ติดตั้งด้วย: winget install OpenJS.NodeJS.LTS' 'Red'
                } elseif (-not (Test-Path (Join-Path $RedeemDir 'node_modules'))) {
                    Write-Log 'มีโค้ดใหม่แต่ยังไม่ได้ npm install ในโฟลเดอร์ redeem' 'Red'
                } else {
                    # Zone4 ต้องเปิดเบราว์เซอร์จริงผ่านด่านตรวจบอท จึงไม่รวมในรอบอัตโนมัติ
                    $ids = @($withNew | Where-Object { $_.id -ne 'zone4' } | ForEach-Object { $_.id })
                    if (@($withNew | Where-Object { $_.id -eq 'zone4' }).Count) {
                        Write-Log 'Zone4 มีโค้ดใหม่ — ต้องตรวจแยกด้วย: node run.mjs --game=zone4 --profile --commit' 'Yellow'
                    }
                    if ($ids.Count) {
                        Write-Log ("สั่งตรวจโค้ดใหม่: {0}" -f ($ids -join ', ')) 'Cyan'
                        Push-Location $RedeemDir
                        try {
                            & node run.mjs --commit "--game=$($ids -join ',')" 2>&1 | ForEach-Object { Write-Log "    $_" }
                        } finally { Pop-Location }
                    }
                }
            }
        }
    } catch {
        Write-Log "รอบ $round ผิดพลาด: $($_.Exception.Message)" 'Red'
    }

    if ($Once) { break }
    Start-Sleep -Seconds ($IntervalMinutes * 60)
}
