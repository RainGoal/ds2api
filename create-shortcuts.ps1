# 创建桌面快捷方式：启动 / 停止 DeepSeek API 代理、编辑配置
# 由 install-shortcuts.bat 调用（powershell -File），也可单独运行

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$proj = $PSScriptRoot
$assets = Join-Path $proj 'assets'
if (-not (Test-Path $assets)) { New-Item -ItemType Directory -Path $assets | Out-Null }

function New-IconFile {
    param([string]$Path, [string]$Kind)
    $bmp = New-Object System.Drawing.Bitmap 32, 32
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    switch ($Kind) {
        'start'  { $bg = [System.Drawing.Color]::FromArgb(255, 40, 167, 69) }
        'stop'   { $bg = [System.Drawing.Color]::FromArgb(255, 200, 55, 55) }
        default  { $bg = [System.Drawing.Color]::FromArgb(255, 45, 100, 180) }
    }
    $brush = New-Object System.Drawing.SolidBrush $bg
    $g.FillEllipse($brush, (New-Object System.Drawing.Rectangle 1, 1, 30, 30))
    $white = [System.Drawing.Brushes]::White
    if ($Kind -eq 'start') {
        $tri = [System.Drawing.Point[]]@(
            (New-Object System.Drawing.Point 12, 8),
            (New-Object System.Drawing.Point 25, 16),
            (New-Object System.Drawing.Point 12, 24)
        )
        $g.FillPolygon($white, $tri)
    } elseif ($Kind -eq 'stop') {
        $g.FillRectangle($white, 10, 10, 12, 12)
    } else {
        $g.FillRectangle($white, 8, 10, 16, 3)
        $g.FillRectangle($white, 8, 19, 16, 3)
        $g.FillRectangle($white, 12, 7, 3, 9)
        $g.FillRectangle($white, 17, 16, 3, 9)
    }
    $g.Dispose()
    $hicon = $bmp.GetHicon()
    $icon = [System.Drawing.Icon]::FromHandle($hicon)
    $fs = [System.IO.File]::Create($Path)
    $icon.Save($fs)
    $fs.Close()
    $bmp.Dispose()
}

function New-Shortcut {
    param([string]$Name, [string]$Target, [string]$Arguments, [string]$Desc, [string]$Icon)
    $lnkPath = Join-Path $desktop ($Name + '.lnk')
    $lnk = $shell.CreateShortcut($lnkPath)
    $lnk.TargetPath = $Target
    if ($Arguments) { $lnk.Arguments = $Arguments }
    $lnk.WorkingDirectory = $proj
    $lnk.Description = $Desc
    if ($Icon -and (Test-Path ($Icon.Split(',')[0]))) { $lnk.IconLocation = $Icon }
    $lnk.Save()
    Write-Host "  已创建: $Name.lnk"
}

$shell = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')

$icons = @{}
foreach ($kind in @('start', 'stop', 'config')) {
    $ip = Join-Path $assets "$kind.ico"
    try {
        New-IconFile -Path $ip -Kind $kind
        $icons[$kind] = "$ip,0"
    } catch {
        $icons[$kind] = ''   # 图标生成失败则用默认图标
    }
}

New-Shortcut -Name '启动DeepSeek代理' `
    -Target (Join-Path $proj 'start.bat') `
    -Desc '启动 DeepSeek 网页版 API 代理（本地 OpenAI 兼容接口）' `
    -Icon $icons['start']

New-Shortcut -Name '停止DeepSeek代理' `
    -Target (Join-Path $proj 'stop.bat') `
    -Desc '停止 DeepSeek 网页版 API 代理' `
    -Icon $icons['stop']

New-Shortcut -Name 'DeepSeek代理配置' `
    -Target "$env:SystemRoot\System32\notepad.exe" `
    -Arguments ('"' + (Join-Path $proj 'config.json') + '"') `
    -Desc '编辑 ds2api 配置（token、端口等）' `
    -Icon $icons['config']

Write-Host '桌面快捷方式创建完成。'
