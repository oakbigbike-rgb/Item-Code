<#
.SYNOPSIS
    ดึงข้อมูลโค้ดของทุกเกมจาก Google Sheets แล้วสร้าง web\data\codes.json ให้หน้า dashboard ใช้

.DESCRIPTION
    ไม่ต้องติดตั้งอะไรเพิ่ม ใช้ Windows PowerShell 5.1 ที่ติดมากับเครื่องได้เลย
    ชีทต้องตั้งค่าแชร์เป็น "ผู้ที่มีลิงก์ - ผู้อ่าน" ไม่งั้นจะได้ HTTP 401

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\Update-Codes.ps1
#>
[CmdletBinding()]
param(
    [string]$ConfigPath,
    [string]$OutPath
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir   = Split-Path -Parent $ScriptDir
if (-not $ConfigPath) { $ConfigPath = Join-Path $RootDir 'config\sources.json' }
if (-not $OutPath)    { $OutPath    = Join-Path $RootDir 'web\data\codes.json' }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$MaxCols  = 40
$Headers  = 0..($MaxCols - 1) | ForEach-Object { "c$_" }
$TempDir  = Join-Path $env:TEMP ('itemcode-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

$MonthAbbr = @{
    'jan'=1;'feb'=2;'mar'=3;'apr'=4;'may'=5;'jun'=6
    'jul'=7;'july'=7;'aug'=8;'sep'=9;'sept'=9;'oct'=10;'nov'=11;'dec'=12
    'ม.ค.'=1;'ก.พ.'=2;'มี.ค.'=3;'เม.ย.'=4;'พ.ค.'=5;'มิ.ย.'=6
    'ก.ค.'=7;'ส.ค.'=8;'ก.ย.'=9;'ต.ค.'=10;'พ.ย.'=11;'ธ.ค.'=12
}

# ---------------------------------------------------------------- helpers

function Get-RemoteText {
    param([string]$Url)
    $file = Join-Path $TempDir ([guid]::NewGuid().ToString('N'))
    try {
        Invoke-WebRequest -Uri $Url -OutFile $file -UseBasicParsing -TimeoutSec 60 | Out-Null
    } catch {
        throw "โหลดไม่ได้ ($Url): $($_.Exception.Message)"
    }
    $text = [IO.File]::ReadAllText($file, [Text.Encoding]::UTF8)
    Remove-Item $file -Force -ErrorAction SilentlyContinue
    return $text
}

# อ่านรายชื่อชีท (name + gid) จากหน้า htmlview ทำให้ชีทวันใหม่ถูกดึงอัตโนมัติ
function Get-SheetList {
    param([string]$DocId)
    $html = Get-RemoteText "https://docs.google.com/spreadsheets/d/$DocId/htmlview"
    $rx   = [regex]'name:\s*"((?:[^"\\]|\\.)*)".*?gid:\s*"(\d+)"'
    $out  = @()
    foreach ($m in $rx.Matches($html)) {
        $name = $m.Groups[1].Value -replace '\\x3d', '=' -replace '\\/', '/' -replace '\\u003d', '='
        $out += [pscustomobject]@{ Name = $name.Trim(); Gid = $m.Groups[2].Value }
    }
    if (-not $out) { throw "อ่านรายชื่อชีทของ $DocId ไม่ได้ (ชีทอาจไม่ได้แชร์แบบ public)" }
    return $out
}

# แปลง CSV เป็น array ของ string[] โดยรักษาลำดับคอลัมน์ไว้ (ใช้ ConvertFrom-Csv เพื่อให้รองรับ quote/newline ในเซลล์)
function ConvertTo-Grid {
    param([string]$Csv)
    if ([string]::IsNullOrWhiteSpace($Csv)) { return @() }
    $objs = $Csv | ConvertFrom-Csv -Header $Headers
    $grid = New-Object 'System.Collections.Generic.List[string[]]'
    foreach ($o in $objs) {
        $row = New-Object 'string[]' $MaxCols
        for ($i = 0; $i -lt $MaxCols; $i++) {
            $v = $o.("c$i")
            $row[$i] = if ($null -eq $v) { '' } else { ([string]$v).Trim() }
        }
        $grid.Add($row) | Out-Null
    }
    return $grid
}

function Get-Cell {
    param($Row, [int]$Index)
    if ($null -eq $Row -or $Index -ge $Row.Length) { return '' }
    $v = $Row[$Index]
    if ($null -eq $v) { return '' } else { return $v }
}

function ConvertTo-Iso {
    param([int]$Y, [int]$M, [int]$D, [string]$Time)
    if ($Y -lt 1 -or $M -lt 1 -or $M -gt 12 -or $D -lt 1 -or $D -gt 31) { return $null }
    $t = ''
    if ($Time) {
        $clean = ($Time -replace '[^\d\.:]', '') -replace '\.', ':'
        if ($clean -match '^(\d{1,2}):(\d{2})') {
            $hh = [int]$Matches[1]; $mm = [int]$Matches[2]
            if ($hh -le 23 -and $mm -le 59) { $t = 'T{0:00}:{1:00}' -f $hh, $mm }
        }
    }
    return ('{0:0000}-{1:00}-{2:00}' -f $Y, $M, $D) + $t
}

# รองรับ 9-Aug-2026 / 16-ส.ค.-2026 / 16/08/26 / 16/08/2026
function Parse-AnyDate {
    param([string]$Text, [string]$Time)
    if (-not $Text) { return $null }
    $s = $Text.Trim()

    if ($s -match '(\d{1,2})\s*[-\s]\s*([A-Za-zก-๙\.]+)\s*[-\s]\s*(\d{2,4})') {
        $d = [int]$Matches[1]; $key = $Matches[2].ToLower().Trim(); $y = [int]$Matches[3]
        if ($MonthAbbr.ContainsKey($key)) {
            $m = $MonthAbbr[$key]
            if ($y -lt 100) { $y += 2000 }
            if ($y -gt 2400) { $y -= 543 }   # พ.ศ. -> ค.ศ.
            return (ConvertTo-Iso -Y $y -M $m -D $d -Time $Time)
        }
    }
    if ($s -match '(\d{1,2})/(\d{1,2})/(\d{2,4})') {
        $d = [int]$Matches[1]; $m = [int]$Matches[2]; $y = [int]$Matches[3]
        if ($y -lt 100) { $y += 2000 }
        if ($y -gt 2400) { $y -= 543 }
        return (ConvertTo-Iso -Y $y -M $m -D $d -Time $Time)
    }
    return $null
}

# ชีท Zone4 สลับไปมาระหว่าง M/d/yyyy กับ d/M/yyyy จึงใช้ชื่อชีท (เดือน) เป็นตัวตัดสิน
function Parse-Zone4Date {
    param([string]$Text, [int]$SheetMonth)
    if ($Text -notmatch '^(\d{1,2})/(\d{1,2})/(\d{4})$') { return $null }
    $a = [int]$Matches[1]; $b = [int]$Matches[2]; $y = [int]$Matches[3]
    if ($y -gt 2400) { $y -= 543 }
    $dayFirst   = ($b -eq $SheetMonth -and $a -le 31)
    $monthFirst = ($a -eq $SheetMonth -and $b -le 31)
    if ($dayFirst)        { return (ConvertTo-Iso -Y $y -M $b -D $a) }
    elseif ($monthFirst)  { return (ConvertTo-Iso -Y $y -M $a -D $b) }
    elseif ($a -gt 12)    { return (ConvertTo-Iso -Y $y -M $b -D $a) }
    else                  { return (ConvertTo-Iso -Y $y -M $a -D $b) }
}

function Get-SheetMonth {
    param([string]$SheetName)
    $key = ($SheetName -replace '[^A-Za-z]', '').ToLower()
    if ($MonthAbbr.ContainsKey($key)) { return $MonthAbbr[$key] }
    return 0
}

# วันที่ประจำชีท เช่น "Master Code 16/08/2026" ที่หัวชีทรายวัน
function Get-SheetDate {
    param($Grid)
    foreach ($row in $Grid[0..([Math]::Min(3, $Grid.Count - 1))]) {
        foreach ($cell in $row) {
            if ($cell -match '^\s*\d{1,2}/\d{1,2}/\d{2,4}\s*$') { return (Parse-AnyDate $cell) }
        }
        $joined = ($row -join ' ')
        if ($joined -match '(\d{1,2}/\d{1,2}/\d{2,4})') { return (Parse-AnyDate $Matches[1]) }
    }
    return $null
}

function Add-Condition {
    param($List, [string]$Value)
    if ($Value -and ($List -notcontains $Value)) { $List.Add($Value) | Out-Null }
}

# ---------------------------------------------------------------- parsers

# WarZ / Talesrunner : บล็อกที่ขึ้นต้นด้วยเซลล์ "CODE"
function Parse-BlockLayout {
    param($Grid, [string]$SheetName)

    $codes     = New-Object 'System.Collections.Generic.List[object]'
    $sheetDate = Get-SheetDate $Grid
    $current   = $null
    $itemMode  = ''   # 'warz' | 'tr' — กำหนดจากแถวหัวตารางไอเทมที่เจอในชีท

    for ($i = 0; $i -lt $Grid.Count; $i++) {
        $row = $Grid[$i]
        $c1  = Get-Cell $row 1

        if ($c1 -eq 'CODE') {
            $current = [ordered]@{
                code       = (Get-Cell $row 2)
                sheet      = $SheetName
                date       = $sheetDate
                start      = (Parse-AnyDate (Get-Cell $row 8) (Get-Cell $row 9))
                end        = $null
                limit      = ''
                note       = (Get-Cell $row 10)
                conditions = (New-Object 'System.Collections.Generic.List[string]')
                items      = (New-Object 'System.Collections.Generic.List[object]')
            }
            $codes.Add($current) | Out-Null
            continue
        }
        if (-not $current) { continue }

        if ((Get-Cell $row 7) -eq 'End' -and -not $current.end) {
            $current.end = Parse-AnyDate (Get-Cell $row 8) (Get-Cell $row 9)
            continue
        }
        if ($c1 -eq 'เงื่อนไขเพิ่มเติม') {
            Add-Condition $current['conditions'] (Get-Cell $row 3)
            Add-Condition $current['conditions'] (Get-Cell $row 8)
            continue
        }
        if ($c1 -eq 'Game') {
            if (-not $current.limit) { $current.limit = (Get-Cell $row 8) }
            continue
        }

        # แถวหัวตารางไอเทมบอกว่าชีทนี้ใช้ผังคอลัมน์แบบไหน
        if ((Get-Cell $row 4) -eq 'Item EN') { $itemMode = 'warz'; continue }
        if ($c1 -eq 'fdItemNum')             { $itemMode = 'tr';   continue }
        if ($c1 -eq 'Item Kind')             { continue }

        # WarZ : itemId(2) tier(3) nameEN(4) type(6) amount(7)
        # TR   : fdItemNum(1) fdPosition(2) displayName(5) amt(7)
        $itemName = ''
        $itemId   = ''
        $amount   = ''
        if ($itemMode -eq 'warz' -and (Get-Cell $row 2) -match '^\d{3,}$' -and (Get-Cell $row 4)) {
            $itemId = Get-Cell $row 2; $itemName = Get-Cell $row 4; $amount = Get-Cell $row 7
        } elseif ($itemMode -eq 'tr' -and (Get-Cell $row 1) -match '^\d{3,}$' -and (Get-Cell $row 5)) {
            $itemId = Get-Cell $row 1; $itemName = Get-Cell $row 5; $amount = Get-Cell $row 7
        }
        if ($itemName) {
            $item = [ordered]@{}
            $item['id']     = $itemId
            $item['name']   = $itemName
            $item['amount'] = $amount
            $current['items'].Add($item) | Out-Null
        }
    }
    return $codes
}

# Cabal PC / Cabal M : บล็อกที่มีเซลล์ "Mastercode"
function Parse-CabalLayout {
    param($Grid, [string]$SheetName, [string]$GameName)

    $codes     = New-Object 'System.Collections.Generic.List[object]'
    $sheetDate = Get-SheetDate $Grid
    $pendingEnd = $null
    $pendingCond = New-Object 'System.Collections.Generic.List[string]'
    $pendingLimit = ''
    $pendingGame  = ''
    $current   = $null

    foreach ($row in $Grid) {
        $c1 = Get-Cell $row 1

        if ($c1 -match '^CODE EXPIRE DATE') {
            $raw = Get-Cell $row 3
            $time = if ($raw -match '(\d{1,2}[\.:]\d{2})') { $Matches[1] } else { '23.59' }
            $pendingEnd   = Parse-AnyDate $raw $time
            $pendingCond  = New-Object 'System.Collections.Generic.List[string]'
            $pendingLimit = ''
            $pendingGame  = ''
            $current      = $null
            continue
        }
        if ($c1 -eq 'เงื่อนไขเพิ่มเติม') {
            # หมายเหตุ: ห้ามใช้ `$x = if (..) { $list }` เพราะ PowerShell จะ enumerate list
            # ทำให้ list ว่างกลายเป็น $null
            $target = $pendingCond
            if ($current) { $target = $current['conditions'] }
            Add-Condition $target (Get-Cell $row 3)
            Add-Condition $target (Get-Cell $row 8)
            continue
        }
        if ($c1 -eq 'Game') {
            $pendingGame  = Get-Cell $row 3
            $pendingLimit = Get-Cell $row 8
            continue
        }
        if ($c1 -eq 'Mastercode') {
            $current = [ordered]@{
                code       = (Get-Cell $row 3)
                sheet      = $SheetName
                date       = $sheetDate
                start      = $sheetDate
                end        = $pendingEnd
                limit      = $pendingLimit
                note       = ((Get-Cell $row 6) + ' ' + (Get-Cell $row 8)).Trim()
                gameLabel  = $pendingGame
                conditions = $pendingCond
                items      = (New-Object 'System.Collections.Generic.List[object]')
            }
            $codes.Add($current) | Out-Null
            continue
        }
        if ($current -and (Get-Cell $row 1) -match '^\d{3,}$' -and (Get-Cell $row 6)) {
            $current['items'].Add([ordered]@{
                id     = (Get-Cell $row 2)
                name   = (Get-Cell $row 6)
                amount = (Get-Cell $row 9)
            }) | Out-Null
        }
    }
    return $codes
}

# Zone4 : ตารางรายเดือน คอลัมน์ "Code item"
function Parse-Zone4Layout {
    param($Grid, [string]$SheetName)

    $codes       = New-Object 'System.Collections.Generic.List[object]'
    $sheetMonth  = Get-SheetMonth $SheetName
    $currentDate = $null
    $current     = $null

    foreach ($row in $Grid) {
        $dateCell = Get-Cell $row 1
        if ($dateCell -match '^\d{1,2}/\d{1,2}/\d{4}$') {
            $parsed = Parse-Zone4Date $dateCell $sheetMonth
            if ($parsed) { $currentDate = $parsed }
        }

        $codeCell = Get-Cell $row 5
        if ($codeCell -and $codeCell -ne 'Code item') {
            $current = [ordered]@{
                code       = $codeCell
                sheet      = $SheetName
                date       = $currentDate
                start      = $currentDate
                end        = $currentDate
                dateOnly   = $true
                limit      = ''
                note       = (Get-Cell $row 11)
                conditions = (New-Object 'System.Collections.Generic.List[string]')
                items      = (New-Object 'System.Collections.Generic.List[object]')
            }
            $codes.Add($current) | Out-Null
        }

        $itemId = Get-Cell $row 3
        if ($current -and $itemId -match '^\d{3,}$') {
            $current['items'].Add([ordered]@{
                id     = $itemId
                name   = (Get-Cell $row 4)
                amount = (Get-Cell $row 8)
            }) | Out-Null
        }
    }
    return $codes
}

# ---------------------------------------------------------------- main

$config = (Get-Content -Raw -Path $ConfigPath -Encoding UTF8) | ConvertFrom-Json
$gameResults = New-Object 'System.Collections.Generic.List[object]'

try {
    $sheetCache = @{}

    foreach ($game in $config.games) {
        Write-Host "`n=== $($game.name) ===" -ForegroundColor Cyan

        if (-not $sheetCache.ContainsKey($game.docId)) {
            $sheetCache[$game.docId] = Get-SheetList $game.docId
        }
        $sheets  = $sheetCache[$game.docId] | Where-Object { $_.Name -match $game.sheetFilter }
        $allCodes = New-Object 'System.Collections.Generic.List[object]'
        $errors   = New-Object 'System.Collections.Generic.List[string]'

        foreach ($sheet in $sheets) {
            Write-Host ("  {0,-12}" -f $sheet.Name) -NoNewline
            try {
                $csv  = Get-RemoteText "https://docs.google.com/spreadsheets/d/$($game.docId)/export?format=csv&gid=$($sheet.Gid)"
                $grid = ConvertTo-Grid $csv
                switch ($game.layout) {
                    'block' { $parsed = Parse-BlockLayout $grid $sheet.Name }
                    'cabal' { $parsed = Parse-CabalLayout $grid $sheet.Name $game.name }
                    'zone4' { $parsed = Parse-Zone4Layout $grid $sheet.Name }
                    default { throw "ไม่รู้จัก layout '$($game.layout)'" }
                }
                foreach ($c in $parsed) {
                    $c['gameId']   = $game.id
                    $c['gameName'] = $game.name
                    $c['sheetUrl'] = "https://docs.google.com/spreadsheets/d/$($game.docId)/edit#gid=$($sheet.Gid)"
                    $c['hasCode']  = [bool]$c.code
                    $allCodes.Add($c) | Out-Null
                }
                $filled = 0
                foreach ($c in $parsed) { if ($c.code) { $filled++ } }
                Write-Host ("{0,3} บล็อก / {1,3} มีโค้ด" -f $parsed.Count, $filled) -ForegroundColor DarkGray
            } catch {
                Write-Host "ผิดพลาด: $($_.Exception.Message)" -ForegroundColor Red
                Write-Verbose $_.ScriptStackTrace
                $errors.Add("$($sheet.Name): $($_.Exception.Message)") | Out-Null
            }
        }

        $sheetNames = New-Object 'System.Collections.Generic.List[string]'
        foreach ($s in $sheets) { $sheetNames.Add([string]$s.Name) | Out-Null }

        $entry = [ordered]@{}
        $entry['id']     = $game.id
        $entry['name']   = $game.name
        $entry['docUrl'] = "https://docs.google.com/spreadsheets/d/$($game.docId)/edit"
        $entry['redeem'] = $game.redeem
        $entry['sheets'] = $sheetNames.ToArray()
        $entry['errors'] = $errors.ToArray()
        $entry['codes']  = $allCodes.ToArray()
        $gameResults.Add($entry) | Out-Null
    }

    $result = [ordered]@{}
    $result['generatedAt'] = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
    $result['games']       = $gameResults.ToArray()

    $dir = Split-Path -Parent $OutPath
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

    # ---- เทียบกับรอบก่อน เพื่อรู้ว่ามีชีทใหม่ / โค้ดใหม่ / โค้ดหายไปบ้างไหม
    $prev = $null
    if (Test-Path $OutPath) {
        try { $prev = (Get-Content -Raw -Path $OutPath -Encoding UTF8) | ConvertFrom-Json } catch { $prev = $null }
    }

    $changed = New-Object 'System.Collections.Generic.List[object]'
    foreach ($g in $result.games) {
        $old = $null
        if ($prev) { $old = $prev.games | Where-Object { $_.id -eq $g.id } | Select-Object -First 1 }

        $oldCodes  = @{}
        $oldSheets = @{}
        if ($old) {
            foreach ($c in $old.codes) { if ($c.code) { $oldCodes[[string]$c.code] = $c } }
            foreach ($s in $old.sheets) { $oldSheets[[string]$s] = $true }
        }

        $newCodes   = New-Object 'System.Collections.Generic.List[object]'
        $seenNow    = @{}
        foreach ($c in $g.codes) {
            if (-not $c.code) { continue }
            $seenNow[[string]$c.code] = $true
            if ($old -and -not $oldCodes.ContainsKey([string]$c.code)) {
                $newCodes.Add([ordered]@{ code = $c.code; date = $c.date; sheet = $c.sheet }) | Out-Null
            }
        }
        $gone = New-Object 'System.Collections.Generic.List[string]'
        foreach ($k in $oldCodes.Keys) { if (-not $seenNow.ContainsKey($k)) { $gone.Add($k) | Out-Null } }

        $newSheets = New-Object 'System.Collections.Generic.List[string]'
        foreach ($s in $g.sheets) { if ($old -and -not $oldSheets.ContainsKey([string]$s)) { $newSheets.Add([string]$s) | Out-Null } }

        if ($newCodes.Count -or $gone.Count -or $newSheets.Count) {
            $entry = [ordered]@{}
            $entry['id']         = $g.id
            $entry['name']       = $g.name
            $entry['newSheets']  = $newSheets.ToArray()
            $entry['newCodes']   = $newCodes.ToArray()
            $entry['goneCodes']  = $gone.ToArray()
            $changed.Add($entry) | Out-Null
        }
    }

    $json = $result | ConvertTo-Json -Depth 12 -Compress
    [IO.File]::WriteAllText($OutPath, $json, (New-Object Text.UTF8Encoding $false))

    # เขียนสำเนาเป็น .js ด้วย เพื่อให้เปิด index.html ตรง ๆ ผ่าน file:// ได้โดยไม่ติด CORS
    $jsPath = [IO.Path]::ChangeExtension($OutPath, '.js')
    [IO.File]::WriteAllText($jsPath, "window.CODES_DATA = $json;", (New-Object Text.UTF8Encoding $false))

    # ---- ประวัติการเปลี่ยนแปลง (เก็บ 100 รอบล่าสุด) ให้ dashboard เอาไปโชว์
    $changesPath = Join-Path $dir 'changes.json'
    $history = New-Object 'System.Collections.Generic.List[object]'
    if (Test-Path $changesPath) {
        try {
            $oldChanges = (Get-Content -Raw -Path $changesPath -Encoding UTF8) | ConvertFrom-Json
            foreach ($h in @($oldChanges.history)) { if ($h) { $history.Add($h) | Out-Null } }
        } catch { }
    }
    if ($changed.Count) {
        $history.Insert(0, [ordered]@{
            at    = $result['generatedAt']
            games = $changed.ToArray()
        })
    }
    while ($history.Count -gt 100) { $history.RemoveAt($history.Count - 1) }

    $changesDoc = [ordered]@{ updatedAt = $result['generatedAt']; history = $history.ToArray() }
    $changesJson = $changesDoc | ConvertTo-Json -Depth 8 -Compress
    [IO.File]::WriteAllText($changesPath, $changesJson, (New-Object Text.UTF8Encoding $false))
    [IO.File]::WriteAllText((Join-Path $dir 'changes.js'), "window.CODES_CHANGES = $changesJson;", (New-Object Text.UTF8Encoding $false))

    # ---- ไฟล์เล็ก ๆ ให้หน้าเว็บ poll เช็คว่ามีข้อมูลใหม่หรือยัง (ไม่ต้องโหลด codes.json ทั้งก้อน)
    $perGame = [ordered]@{}
    $total = 0
    foreach ($g in $result.games) {
        $n = 0
        foreach ($c in $g.codes) { if ($c.hasCode) { $n++ } }
        $perGame[$g.id] = $n
        $total += $n
    }
    $version = [ordered]@{ generatedAt = $result['generatedAt']; total = $total; perGame = $perGame }
    [IO.File]::WriteAllText((Join-Path $dir 'version.json'),
        ($version | ConvertTo-Json -Depth 5 -Compress), (New-Object Text.UTF8Encoding $false))

    Write-Host "`nเขียนไฟล์แล้ว: $OutPath" -ForegroundColor Green
    Write-Host "รวมโค้ดที่มีจริง $total รายการ" -ForegroundColor Green

    if ($changed.Count) {
        Write-Host "`nมีการเปลี่ยนแปลง:" -ForegroundColor Yellow
        foreach ($c in $changed) {
            $bits = @()
            if ($c.newSheets.Count) { $bits += "ชีทใหม่ $($c.newSheets.Count) ($($c.newSheets -join ', '))" }
            if ($c.newCodes.Count)  { $bits += "โค้ดใหม่ $($c.newCodes.Count)" }
            if ($c.goneCodes.Count) { $bits += "โค้ดหายไป $($c.goneCodes.Count)" }
            Write-Host ("  {0,-12} {1}" -f $c.name, ($bits -join ' · ')) -ForegroundColor Yellow
        }
    } elseif ($prev) {
        Write-Host "ไม่มีอะไรเปลี่ยนจากรอบก่อน" -ForegroundColor DarkGray
    }
}
catch {
    Write-Host "`nล้มเหลว: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkYellow
    throw
}
finally {
    Remove-Item $TempDir -Recurse -Force -ErrorAction SilentlyContinue
}
