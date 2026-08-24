<#
.SYNOPSIS
    เสิร์ฟโฟลเดอร์ web\ ผ่าน http://localhost:<Port>/

.DESCRIPTION
    เปิด index.html ตรง ๆ ผ่าน file:// ก็ใช้งานได้ (ข้อมูลโหลดจาก data\codes.js)
    สคริปต์นี้มีไว้เผื่ออยากเปิดผ่าน http เช่นจะเปิดจากเครื่องอื่นในวง LAN

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\Serve.ps1
#>
param(
    [int]$Port = 4173,
    # เปิดให้เครื่องอื่นในวง LAN เข้าดูได้ — ต้องสั่งเองเท่านั้น เพราะทุกคนในวงจะเห็นโค้ดทั้งหมด
    [switch]$AllowLan
)

$ErrorActionPreference = 'Stop'
$root = Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) 'web'

$mime = @{
    '.html' = 'text/html; charset=utf-8'
    '.js'   = 'application/javascript; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
}

$listener = New-Object System.Net.HttpListener
if ($AllowLan) {
    # ต้องรันแบบ Administrator และต้องเปิดพอร์ตใน Windows Firewall เอง
    $listener.Prefixes.Add("http://+:$Port/")
} else {
    # ระบุ IP ตรง ๆ แทนคำว่า localhost เพื่อให้ผูกกับ loopback เท่านั้นแน่นอน
    $listener.Prefixes.Add("http://127.0.0.1:$Port/")
    $listener.Prefixes.Add("http://[::1]:$Port/")
}
$listener.Start()

if ($AllowLan) {
    Write-Host "เสิร์ฟ $root ที่พอร์ต $Port — เปิดให้ทั้งเครือข่าย" -ForegroundColor Yellow
    Write-Host "ทุกคนในวง LAN เห็นโค้ดทั้งหมดได้ ปิดทันทีเมื่อใช้เสร็จ" -ForegroundColor Yellow
} else {
    Write-Host "เสิร์ฟ $root ที่ http://127.0.0.1:$Port/  (เฉพาะเครื่องนี้ · Ctrl+C เพื่อหยุด)" -ForegroundColor Green
}

try {
    while ($listener.IsListening) {
        $ctx = $listener.GetContext()
        $res = $ctx.Response
        # ห่อทั้งคำขอไว้ เพื่อไม่ให้คำขอเดียวที่พังทำให้เซิร์ฟเวอร์หยุดทั้งตัว
        try {
            $rel = [Uri]::UnescapeDataString($ctx.Request.Url.LocalPath).TrimStart('/')
            if (-not $rel) { $rel = 'index.html' }

            $full = [IO.Path]::GetFullPath((Join-Path $root $rel))

            # กันการไต่ path ออกนอกโฟลเดอร์ web\
            $inRoot = $full.StartsWith([IO.Path]::GetFullPath($root), [StringComparison]::OrdinalIgnoreCase)
            if ($inRoot -and (Test-Path $full -PathType Leaf)) {
                $ext   = [IO.Path]::GetExtension($full).ToLower()
                $bytes = [IO.File]::ReadAllBytes($full)
                if ($mime.ContainsKey($ext)) { $res.ContentType = $mime[$ext] }
                else { $res.ContentType = 'application/octet-stream' }
                # ข้อมูลถูกเขียนทับเรื่อย ๆ ห้ามให้เบราว์เซอร์แคชไว้ ไม่งั้นรีเฟรชแล้วยังได้ของเก่า
                $res.Headers.Add('Cache-Control', 'no-cache, no-store, must-revalidate')
                $res.SendChunked      = $false
                $res.KeepAlive        = $false
                $res.ContentLength64  = $bytes.LongLength
                if ($ctx.Request.HttpMethod -ne 'HEAD') {
                    $res.OutputStream.Write($bytes, 0, $bytes.Length)
                    $res.OutputStream.Flush()
                }
            } else {
                $res.StatusCode = 404
                $res.ContentLength64 = 0
            }
        } catch {
            Write-Host "  คำขอผิดพลาด: $($_.Exception.Message)" -ForegroundColor DarkYellow
        } finally {
            try { $res.Close() } catch { }
        }
    }
} finally {
    $listener.Stop()
}
