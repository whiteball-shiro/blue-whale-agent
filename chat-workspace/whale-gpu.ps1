# 深蓝鲸桌宠 GPU 串行切换脚本
# 用法:
#   powershell -File whale-gpu.ps1 status                     查看当前状态
#   powershell -File whale-gpu.ps1 to-text                    只恢复文本模型（llama-server）
#   powershell -File whale-gpu.ps1 to-image                   停文本模型并启动 ComfyUI（供手动生图）
#   powershell -File whale-gpu.ps1 dedupe                     检测并清理重复的 llama-server 实例
#   powershell -File whale-gpu.ps1 generate "提示词" [输出路径]  一键生图：停文本->启ComfyUI->生成->关ComfyUI->恢复文本
#   powershell -File whale-gpu.ps1 generate "提示词" -Width 512 -Height 512 -Steps 12

param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Action,
  [Parameter(Position = 1)][string]$Prompt = '',
  [string]$Out = '',
  [int]$Width = 512,
  [int]$Height = 512,
  [int]$Steps = 12
)

$ErrorActionPreference = 'Stop'

# ---- 文本模型（llama-server，由 LM Studio 管理，端口 49674，经 1234 网关代理） ----
$llamaExe = 'COM:USERHOME\.lmstudio\extensions\backends\llama.cpp-win-x86_64-nvidia-cuda12-avx2-2.31.2\llama-server.exe'
$cudaVendor = 'COM:USERHOME\.lmstudio\extensions\backends\vendor\win-llama-cuda12-vendor-v2'
$llamaArgs = '--model "COM:QWEN_MODEL" --host 127.0.0.1 --port 49674 --api-key COM:LM_API_KEY --verbosity 3 --no-webui --jinja --chat-template-file COM:USERHOME\.lmstudio\whale-pet-chat-template.jinja --ctx-size 4096 --n-gpu-layers 20 --n-cpu-moe 0 --main-gpu 0 --tensor-split 0 --split-mode layer --ctx-checkpoints 32 --batch-size 512 --ubatch-size 512 --threads 6 --parallel 1 --cache-type-k q4_0 --cache-type-v q4_0 --mmproj "COM:QWEN_MMPROJ" --flash-attn on --kv-offload --kv-unified --load-mode mmap+mlock'

# ---- 重复实例检测：脚本直启实例的识别特征（固定端口 / 固定 api-key / chat 模板） ----
$LlamaOwnPort = 49674
$LlamaOwnApiKey = 'COM:LM_API_KEY'

# ---- 生图（ComfyUI + Anima/Qwen-Image，端口 8188，LOW_VRAM 防爆显存） ----
$comfyPy = 'COM:COMFY_PY'
$comfyDir = 'COM:COMFY_DIR'
$comfyCli = 'COM:USERHOME\plugins\comfy-imagegen\scripts\mcp_server.py'

# ---- 启动时读 config.local.json，把占位符替换成本机真实路径/密钥（此文件已被 .gitignore 忽略） ----
$CfgPath = Join-Path $PSScriptRoot 'config.local.json'
if (Test-Path $CfgPath) {
  try {
    $Cfg = Get-Content $CfgPath -Raw | ConvertFrom-Json
    if ($Cfg.localModelPath)    { $llamaArgs = ($llamaArgs -replace '--model\s+"[^"]*"', ('--model "' + $Cfg.localModelPath + '"')) }
    if ($Cfg.localModelMmproj)  { $llamaArgs = ($llamaArgs -replace '--mmproj\s+"[^"]*"', ('--mmproj "' + $Cfg.localModelMmproj + '"')) }
    if ($Cfg.localLlamaApiKey)  { $llamaArgs = ($llamaArgs -replace '--api-key\s+\S+', ('--api-key ' + $Cfg.localLlamaApiKey)); $LlamaOwnApiKey = $Cfg.localLlamaApiKey }
    if ($Cfg.localLlamaExe)     { $llamaExe = $Cfg.localLlamaExe }
    if ($Cfg.comfyPy)           { $comfyPy = $Cfg.comfyPy }
    if ($Cfg.comfyDir)          { $comfyDir = $Cfg.comfyDir }
    if ($Cfg.comfyCli)          { $comfyCli = $Cfg.comfyCli }
  } catch { }
}

function Test-Port([int]$port) {
  try { (Test-NetConnection -ComputerName 127.0.0.1 -Port $port -WarningAction SilentlyContinue).TcpTestSucceeded } catch { $false }
}

function Wait-Port([int]$port, [int]$seconds) {
  for ($i = 0; $i -lt $seconds; $i += 2) {
    if (Test-Port $port) { return $true }
    Start-Sleep -Seconds 2
  }
  return (Test-Port $port)
}

function Get-LlamaPorts {
  # LM Studio 每次启动 llama-server 端口都会变，这里从进程命令行读实际 --port
  $ports = @()
  try {
    $lines = Get-CimInstance Win32_Process -Filter "Name = 'llama-server.exe'" | Select-Object -ExpandProperty CommandLine
    foreach ($line in $lines) {
      if ($line -match '--port\s+(\d+)') { $ports += [int]$Matches[1] }
    }
  } catch { }
  return ($ports | Sort-Object -Unique)
}

function Get-LlamaServerInfo {
  # 返回所有 llama-server 进程的 PID / 端口 / 命令行
  $items = @()
  try {
    $procs = Get-CimInstance Win32_Process -Filter "Name = 'llama-server.exe'"
    foreach ($p in $procs) {
      $port = 0
      if ($p.CommandLine -match '--port\s+(\d+)') { $port = [int]$Matches[1] }
      $items += [pscustomobject]@{ ProcessId = $p.ProcessId; Port = $port; CommandLine = $p.CommandLine }
    }
  } catch { }
  return $items
}

function Test-OwnLlamaInstance([string]$commandLine) {
  # 三要素命中任一即视为脚本直启的实例
  if ($commandLine -match "--port\s+$LlamaOwnPort") { return $true }
  if ($commandLine -match [regex]::Escape($LlamaOwnApiKey)) { return $true }
  if ($commandLine -match 'whale-pet-chat-template\.jinja') { return $true }
  return $false
}

function Dedupe-LlamaServers {
  # 自动解决“双实例并存”隐患：
  # 1) 已有 LM Studio 托管的在线实例时，脚本直启的实例属于冗余 -> 清掉直启实例
  # 2) 只有直启实例但存在多份 -> 保留一份
  # 多个非直启实例不干预（可能是用户在 LM Studio 里主动加载的）
  $servers = @(Get-LlamaServerInfo)
  if ($servers.Count -le 1) {
    Write-Host "llama-server instances: $($servers.Count) (no duplicate)"
    return
  }
  $own = @($servers | Where-Object { Test-OwnLlamaInstance $_.CommandLine })
  $other = @($servers | Where-Object { -not (Test-OwnLlamaInstance $_.CommandLine) })

  if ($other.Count -gt 0) {
    $otherUp = @($other | Where-Object { $_.Port -gt 0 -and (Test-Port $_.Port) })
    if ($otherUp.Count -gt 0) {
      foreach ($p in $own) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
      if ($own.Count -gt 0) {
        Write-Host "removed $($own.Count) redundant direct llama-server instance(s); kept managed llama-server (port $($otherUp[0].Port))"
      } else {
        Write-Host "llama-server instances: $($servers.Count) (no direct duplicate to remove)"
      }
      return
    }
  }

  if ($own.Count -gt 1) {
    $keep = $own | Where-Object { $_.Port -eq $LlamaOwnPort } | Select-Object -First 1
    if (-not $keep) { $keep = $own[0] }
    foreach ($p in $own | Where-Object { $_.ProcessId -ne $keep.ProcessId }) {
      Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Write-Host "removed $($own.Count - 1) duplicate direct llama-server instance(s); kept pid $($keep.ProcessId)"
    return
  }

  Write-Host "llama-server instances: $($servers.Count) (no duplicate)"
}

function Get-Vram {
  $s = nvidia-smi --query-gpu=memory.used,memory.free --format=csv,noheader 2>$null
  if ($s) { "VRAM used/free (MiB): $s" } else { 'VRAM: n/a' }
}

function Stop-TextModel {
  $procs = Get-Process -Name llama-server -ErrorAction SilentlyContinue
  if ($procs) { $procs | Stop-Process -Force; Write-Host "text model stopped ($($procs.Count) process)" } else { Write-Host 'text model not running' }
  Start-Sleep -Seconds 3
}

function Start-TextModel {
  Dedupe-LlamaServers
  $running = @(Get-LlamaPorts | Where-Object { Test-Port $_ })
  if ($running.Count) { Write-Host "llama-server already running (port $($running -join ','))"; return }
  $env:Path = "$cudaVendor;$env:Path"
  $p = Start-Process -FilePath $llamaExe -ArgumentList $llamaArgs -WindowStyle Hidden -PassThru
  Write-Host "starting llama-server (pid $($p.Id)), waiting for port 49674..."
  if (Wait-Port 49674 90) { Write-Host 'llama-server up' } else { throw 'llama-server failed to start' }
}

function Start-Comfy {
  if (Test-Port 8188) { Write-Host 'ComfyUI already running'; return $null }
  $p = Start-Process -FilePath $comfyPy -ArgumentList @('main.py', '--listen', '127.0.0.1', '--port', '8188', '--lowvram') -WorkingDirectory $comfyDir -WindowStyle Hidden -PassThru
  Write-Host "starting ComfyUI (pid $($p.Id)), waiting for port 8188..."
  if (Wait-Port 8188 120) { Write-Host 'ComfyUI up'; return $p } else { throw 'ComfyUI failed to start' }
}

function Stop-ComfyAny {
  $procs = Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" | Where-Object { $_.CommandLine -match 'ComfyUI' -and $_.CommandLine -match 'main\.py' }
  if ($procs) {
    foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    $n = if ($procs -is [array]) { $procs.Count } else { 1 }
    Write-Host "ComfyUI stopped ($n process)"
  } else { Write-Host 'ComfyUI not running' }
  Start-Sleep -Seconds 2
}

switch ($Action.ToLower()) {
  'status' {
    Dedupe-LlamaServers
    $textPorts = Get-LlamaPorts
    $textUp = $false
    foreach ($p in $textPorts) { if (Test-Port $p) { $textUp = $true; break } }
    Write-Host "llama-server ($(if ($textPorts) { $textPorts -join ',' } else { 'none' })): $(if ($textUp) { 'UP' } else { 'down' })"
    $modelName = 'none'
    try {
      $p = Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" | Select-Object -First 1
      if ($p -and $p.CommandLine -match '--model\s+"?([^"]+?\.gguf)"?') { $modelName = [System.IO.Path]::GetFileName($Matches[1]) }
    } catch { }
    Write-Host "loaded model: $modelName"
    Write-Host "comfy 8188: $(if (Test-Port 8188) { 'UP' } else { 'down' })"
    Get-Vram
  }
  'dedupe' {
    Dedupe-LlamaServers
    Get-Vram
  }
  'to-text' {
    Stop-ComfyAny
    Start-TextModel
    Get-Vram
  }
  'to-image' {
    Stop-TextModel
    $null = Start-Comfy
    Get-Vram
  }
  'generate' {
    if (-not $Prompt) { throw 'generate needs a prompt' }
    if (-not $Out) { $Out = Join-Path ([Environment]::GetFolderPath('Desktop')) ("whale-img-$(Get-Date -Format 'yyyyMMdd-HHmmss').png") }
    Stop-TextModel
    $null = Start-Comfy
    try {
      & $comfyPy $comfyCli --cli --prompt $Prompt --width $Width --height $Height --steps $Steps --out $Out
    } finally {
      Stop-ComfyAny
      Start-TextModel
    }
    Write-Host "output: $Out"
    Get-Vram
  }
  default { throw "unknown action: $Action (status / to-text / to-image / generate / dedupe)" }
}
