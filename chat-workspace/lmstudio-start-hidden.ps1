# lmstudio-start-hidden.ps1
# 启动 LM Studio 并默认收进托盘（窗口不显示），同时确保本地 Qwen 模型已加载。
#
# 用法:
#   powershell -File lmstudio-start-hidden.ps1           启动并收进托盘
#   powershell -File lmstudio-start-hidden.ps1 -Show     启动并保持窗口显示（供手动操作）
#
# 重要: 不要用 Start-Process -WindowStyle Hidden 启动 LM Studio,
# 那会破坏托盘图标注册, 导致托盘双击无法唤出窗口。
# 正确做法是正常启动 -> 等主窗口出现 -> 发送 WM_CLOSE 收进托盘(应用原生托盘模式)。

param(
  [Alias('Show')][switch]$ShowWindow
)

$ErrorActionPreference = 'Stop'

$lmExe   = $null
$lmsCli  = 'COM:USERHOME\.lmstudio\bin\lms.exe'
$modelId = 'ai model/ai models/COM:QWEN_MODEL'

$CfgPath = Join-Path $PSScriptRoot 'config.local.json'
if (Test-Path $CfgPath) {
  try {
    $Cfg = Get-Content $CfgPath -Raw | ConvertFrom-Json
    if ($Cfg.lmStudioExe) { $lmExe = $Cfg.lmStudioExe }
    if ($Cfg.lmsCli)      { $lmsCli = $Cfg.lmsCli }
    if ($Cfg.localModelId) { $modelId = $Cfg.localModelId }
  } catch { }
}

# 未在 config.local.json 指定 LM Studio 可执行文件时，尝试常见安装位置自动探测
if (-not $lmExe) {
  $candidates = @(
    "$env:LOCALAPPDATA\Programs\LM Studio\LM Studio.exe",
    "$env:ProgramFiles\LM Studio\LM Studio.exe",
    "${env:ProgramFiles(x86)}\LM Studio\LM Studio.exe"
  )
  $found = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if ($found) { $lmExe = $found }
}
if (-not $lmExe) {
  throw '未找到 LM Studio 可执行文件。请在 chat-workspace\config.local.json 中设置 "lmStudioExe" 为 LM Studio.exe 的完整路径。'
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class LmWin32 {
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder buf, int max);
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
}
'@

function Get-MainWindowHandle([int[]]$pids) {
  $script:targetPids = $pids
  $script:mainHwnd = [IntPtr]::Zero
  $cb = [LmWin32+EnumProc]{
    param($h, $l)
    $p = 0
    [LmWin32]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
    if ($script:targetPids -contains $p) {
      $sb = New-Object System.Text.StringBuilder 256
      [LmWin32]::GetWindowText($h, $sb, 256) | Out-Null
      if ($sb.ToString() -eq 'LM Studio' -and [LmWin32]::IsWindowVisible($h)) {
        $script:mainHwnd = $h
        return $false
      }
    }
    return $true
  }
  [LmWin32]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  return $script:mainHwnd
}

function Close-ToTray([IntPtr]$hwnd) {
  [LmWin32]::SendMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $pids = @(Get-Process -Name 'LM Studio' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
    $w = Get-MainWindowHandle $pids
    if ($w -eq [IntPtr]::Zero) { return }
  }
  throw 'LM Studio main window did not close to tray within 20s'
}

function Ensure-ModelLoaded {
  $loaded = @(Get-Process -Name llama-server -ErrorAction SilentlyContinue).Count -gt 0
  if ($loaded) { return $true }
  Write-Host 'loading local Qwen model...'
  & $lmsCli server start | Out-Host
  & $lmsCli load $modelId | Out-Host
  return (@(Get-Process -Name llama-server -ErrorAction SilentlyContinue).Count -gt 0)
}

# ---- 主流程 ----
$running = @(Get-Process -Name 'LM Studio' -ErrorAction SilentlyContinue)
if ($running.Count -eq 0) {
  Write-Host 'starting LM Studio...'
  Start-Process -FilePath $lmExe
  $deadline = (Get-Date).AddSeconds(60)
  $hwnd = [IntPtr]::Zero
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $pids = @(Get-Process -Name 'LM Studio' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
    $hwnd = Get-MainWindowHandle $pids
    if ($hwnd -ne [IntPtr]::Zero) { break }
  }
  if ($hwnd -eq [IntPtr]::Zero) { throw 'LM Studio main window not detected within 60s' }
} else {
  $pids = @($running | Select-Object -ExpandProperty Id)
  $hwnd = Get-MainWindowHandle $pids
}

if (-not $ShowWindow -and $hwnd -ne [IntPtr]::Zero) {
  Write-Host 'hiding LM Studio to tray...'
  Close-ToTray $hwnd
}

$null = Ensure-ModelLoaded
$alive = @(Get-Process -Name 'LM Studio' -ErrorAction SilentlyContinue).Count -gt 0
if (-not $alive) { throw 'LM Studio is not running' }

$top = Get-Process -Name 'LM Studio' -ErrorAction SilentlyContinue | Select-Object -First 1
Write-Host "LM Studio running (pid $($top.Id)) | window: $(if ($ShowWindow) { 'shown' } else { 'hidden in tray' }) | local model: $(if (@(Get-Process -Name llama-server -ErrorAction SilentlyContinue).Count -gt 0) { 'loaded' } else { 'NOT loaded' })"
