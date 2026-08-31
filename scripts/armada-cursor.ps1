# Armada Windows 启动器：用 CDP 端口打开 Cursor，中台才能全自动提交。
#
# 第一次请看仓库 README「Windows（第一次安装 + 每天怎么开）」。
# 每天派发前都要用本脚本启动；从开始菜单/桌面图标打开会停在「待本机回车」。
#
# 用法（先托盘右键完全退出 Cursor）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\armada-cursor.ps1 C:\绝对路径\工作区

$ErrorActionPreference = 'Stop'
$port = if ($env:ARMADA_CDP_PORT) { $env:ARMADA_CDP_PORT } else { '9222' }

if ($args.Count -eq 0) {
  Write-Host @"
Armada Windows 启动器
用法:
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\armada-cursor.ps1 C:\绝对路径\工作区

请先完全退出 Cursor（右下角托盘图标 → 右键退出），再运行本脚本。
不要从开始菜单或桌面图标打开 Cursor，否则中台派发会停在「待本机回车」。
工作区必须是 Windows 绝对路径，例如 C:\Users\me\proj
"@
  exit 1
}

$candidates = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\cursor\Cursor.exe'),
  (Join-Path $env:ProgramFiles 'Cursor\Cursor.exe')
)
if (${env:ProgramFiles(x86)}) {
  $candidates += (Join-Path ${env:ProgramFiles(x86)} 'Cursor\Cursor.exe')
}

$exe = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $exe) {
  Write-Error '找不到 Cursor.exe。请确认已安装 Cursor（已试 %LOCALAPPDATA%\Programs\cursor 与 Program Files）。'
  exit 1
}

$running = Get-Process -Name 'Cursor', 'cursor' -ErrorAction SilentlyContinue
if ($running) {
  Write-Error '检测到 Cursor 仍在运行。请先完全退出：右下角托盘（^）里的 Cursor 图标 → 右键 Exit / 退出，确认任务栏和对话框都没了，再运行本脚本。'
  exit 1
}

$ws = $args -join ' '
Write-Host "Armada 启动器"
Write-Host "  Cursor : $exe"
Write-Host "  CDP    : 127.0.0.1:$port（只绑本机，不对局域网开放）"
Write-Host "  工作区 : $ws"
Write-Host "启动后约 15 秒，中台控制台左侧应出现本机绿点 + 该工作区。不要再双击图标开第二个 Cursor。"

& $exe "--remote-debugging-port=$port" @args
