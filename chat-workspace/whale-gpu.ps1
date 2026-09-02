# 深蓝鲸桌宠 GPU 串行切换脚本（泛化版）
# 用法:
#   powershell -File whale-gpu.ps1 status                  查看当前状态
#   powershell -File whale-gpu.ps1 to-text                 只恢复文本模型（llama-server）
#   powershell -File whale-gpu.ps1 to-image                停文本模型并启动 ComfyUI（供手动生图）
#   powershell -File whale-gpu.ps1 dedupe                  检测并清理重复的 llama-server 实例
#   powershell -File whale-gpu.ps1 generate "提示词" [输出路径]  一键生图：停文本->启ComfyUI->生成->关ComfyUI->恢复文本
#
# 泛化说明：路径 / 端口 / 模型 / 参数优先读取同目录 config.local.json（已被 .gitignore 忽略）；
# 未配置时尽量自动探测（llama-server、ComfyUI、lms、端口），探测不到会给出清晰中文提示。
#
# config.local.json 可用字段（均可选）：
#   localLlamaExe        llama-server.exe 完整路径（留空则自动探测）
#   localModelPath       本地模型 .gguf 路径（直启兜底时需要）
#   localModelMmproj     多模态投影文件路径（识图用，可选）
#   localModelId         用 lms 恢复时要加载的模型 id（留空则自动挑第一个非 embedding）
#   localLlamaApiKey     llama-server 的 api-key（可选）
#   localChatTemplate    聊天模板 .jinja 路径（可选）
#   localCudaVendor      CUDA vendor 目录（可选，直启时加进 PATH）
#   localExtraArgs       直启 llama-server 的额外参数（可选，如 "--batch-size 512 --flash-attn on"）
#   localCtxSize / localGpuLayers / localThreads  直启时的上下文 / 卸载层数 / 线程数
#   localLlamaPort       脚本直启时用的端口（默认 49674）
#   comfyPy / comfyDir / comfyCli   ComfyUI 的 python / 目录 / 生图入口脚本
#   comfyPort            ComfyUI 端口（默认 8188）
#   lmsCli               lms 可执行文件路径（留空则自动探测，用于恢复文本模型）

param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Action,
  [Parameter(Position = 1)][string]$Prompt = '',
  [string]$Out = '',
  [int]$Width = 512,
  [int]$Height = 512,
  [int]$Steps = 12
)

$ErrorActionPreference = 'Stop'

# ---- 读配置（config.local.json，gitignored） ----
$CfgPath = Join-Path $PSScriptRoot 'config.local.json'
$Cfg = @{}
if (Test-Path $CfgPath) {
  try { $Cfg = Get-Content $CfgPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $Cfg = @{} }
}

function Cfg([string]$name, $default) {
  if ($null -ne $Cfg.$name -and "$($Cfg.$name)".Trim() -ne '') { return $Cfg.$name }
  return $default
}

# ---- 自动探测 ----
function Resolve-LlamaExe {
  $v = Cfg 'localLlamaExe' ''
  if ($v) { return $v }
  foreach ($r in @(
    (Join-Path $env:USERPROFILE '.lmstudio\extensions\backends'),
    (Join-Path $env:USERPROFILE '.lmstudio'),
    (Join-Path $env:LOCALAPPDATA 'Programs\LM Studio')
  )) {
    if (Test-Path $r) {
      $f = Get-ChildItem -Path $r -Filter 'llama-server.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($f) { return $f.FullName }
    }
  }
  $c = Get-Command 'llama-server.exe' -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  return ''
}

function Resolve-ComfyPy {
  $v = Cfg 'comfyPy' ''
  if ($v) { return $v }
  foreach ($n in @('python', 'python3')) {
    $c = Get-Command $n -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
  }
  return ''
}

function Resolve-LmsCli {
  $v = Cfg 'lmsCli' ''
  if ($v) { return $v }
  foreach ($p in @(
    (Join-Path $env:USERPROFILE '.lmstudio\bin\lms.exe'),
    (Join-Path $env:LOCALAPPDATA 'lm-studio\bin\lms.exe')
  )) { if (Test-Path $p) { return $p } }
  $c = Get-Command 'lms' -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  return ''
}

# ---- 关键变量（配置优先，自动探测兜底） ----
$llamaExe    = Resolve-LlamaExe
$comfyPy     = Resolve-ComfyPy
$comfyDir    = Cfg 'comfyDir' ''
$comfyCli    = Cfg 'comfyCli' ''
$comfyPort   = [int](Cfg 'comfyPort' 8188)
$llamaOwnPort= [int](Cfg 'localLlamaPort' 49674)
$ctxSize     = [int](Cfg 'localCtxSize' 4096)
$gpuLayers   = [int](Cfg 'localGpuLayers' 20)
$threads     = [int](Cfg 'localThreads' 6)
$modelPath   = Cfg 'localModelPath' ''
$mmproj      = Cfg 'localModelMmproj' ''
$apiKey      = Cfg 'localLlamaApiKey' ''
$chatTemplate= Cfg 'localChatTemplate' ''
$cudaVendor  = Cfg 'localCudaVendor' ''
$lmsCli      = Resolve-LmsCli
$modelId     = Cfg 'localModelId' ''
$extraArgs   = Cfg 'localExtraArgs' ''

# ---- 记录“上次加载的模型”：生图前抓取，生图后恢复同一个 ----
$lastModelFile = Join-Path $PSScriptRoot '.whale-last-model.json'

function Pick-ModelId($m) {
  if ($m -and $m.indexedModelIdentifier) { return $m.indexedModelIdentifier }
  if ($m -and $m.modelKey) { return $m.modelKey }
  return ''
}

function Get-LmsModels {
  # lms ls --json 直接管道给 ConvertFrom-Json 会把整组模型包成一个对象（id 变成全部模型名拼接），
  # 必须先 Out-String 接住再解析，才能拿到真正的模型数组
  try {
    $raw = & $lmsCli ls --json 2>$null | Out-String
    if (-not $raw) { return @() }
    return @($raw | ConvertFrom-Json)
  } catch { return @() }
}

function Get-LmsLoadedId {
  # 当前 LM Studio 正在加载的模型 id（lms ps 是权威来源）；没有则返回空
  try {
    $raw = & $lmsCli ps --json 2>$null | Out-String
    if (-not $raw) { return '' }
    $list = @($raw | ConvertFrom-Json)
    foreach ($m in $list) {
      if ("$($m.type)" -match 'embedding') { continue }
      if ($m.identifier) { return $m.identifier }
      if ($m.indexedModelIdentifier) { return $m.indexedModelIdentifier }
    }
  } catch { }
  return ''
}

function Find-ValidModelId([string]$raw) {
  # 只返回 lms ls 里真实存在的模型 id；脏数据/找不到一律返回空，绝不把拼接串传给 lms load
  if (-not $raw -or -not $lmsCli) { return '' }
  try {
    $clean = [string]$raw
    $clean = $clean.Trim()
    if (-not $clean) { return '' }
    $list = Get-LmsModels
    if (-not $list.Count) { return '' }
    # 1) 完整命中 id / key（LM Studio 的本地模型名可能含空格）
    $hit = @($list | Where-Object { "$($_.indexedModelIdentifier) $($_.modelKey)" -eq $clean })
    if ($hit.Count) { return Pick-ModelId $hit[0] }
    if ($clean -match '\.gguf') {
      # 带 .gguf 的记录必须只指向一个文件；多个文件拼在一起的脏串直接丢弃
      if (([regex]::Matches($clean, '\.gguf')).Count -ne 1) { return '' }
      $fname = [regex]::Match($clean, '([^\\/]+\.gguf)\s*$').Groups[1].Value
      $hit = @($list | Where-Object { "$($_.indexedModelIdentifier) $($_.path) $($_.modelKey) $($_.displayName)" -match [regex]::Escape($fname) })
      if ($hit.Count) { return Pick-ModelId $hit[0] }
      return ''
    }
    # 2) 目录/短名（如 gemma-4-26b-vision）：按路径词命中
    $re = '(^|[\\/])' + [regex]::Escape($clean) + '([\\/]|$)'
    $hit = @($list | Where-Object { "$($_.indexedModelIdentifier) $($_.modelKey) $($_.displayName) $($_.path)" -match $re })
    if ($hit.Count) { return Pick-ModelId $hit[0] }
    return ''
  } catch { return '' }
}

function Get-LoadedModelId {
  # 逐个看正在运行的 llama-server，返回能映射到 lms 模型列表的 id；找不到返回空
  try {
    # 1) LM Studio 正在加载的模型优先（最准确）
    $viaPs = Get-LmsLoadedId
    if ($viaPs) { return $viaPs }
    # 2) 兜底：从 llama-server 命令行解析
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'")
    if (-not $procs.Count) { return '' }
    if (-not $lmsCli) { return '' }
    foreach ($p in $procs) {
      if (-not $p.CommandLine) { continue }
      if ($p.CommandLine -notmatch '--model\s+("[^"]+"|[^\s]+)') { continue }
      $raw = $Matches[1].Trim('"')
      $valid = Find-ValidModelId $raw
      if ($valid) { return $valid }
    }
    return ''
  } catch { return '' }
}
function Read-LastModelId {
  try { if (Test-Path $lastModelFile) { return ((Get-Content $lastModelFile -Raw -Encoding UTF8 | ConvertFrom-Json).modelId) } } catch { }
  return ''
}
function Write-LastModelId([string]$id) {
  try { @{ modelId = $id } | ConvertTo-Json -Compress | Set-Content -LiteralPath $lastModelFile -Encoding UTF8 } catch { }
}

function Test-Port([int]$port) {
  try { (Test-NetConnection -ComputerName 127.0.0.1 -Port $port -WarningAction SilentlyContinue).TcpTestSucceeded } catch { $false }
}
function Wait-Port([int]$port, [int]$seconds) {
  for ($i = 0; $i -lt $seconds; $i += 2) { if (Test-Port $port) { return $true }; Start-Sleep -Seconds 2 }
  return (Test-Port $port)
}

function Wait-ProcExited($proc, [int]$seconds) {
  # 等待进程退出；超时返回 $false。Wait-Process 在成功/超时时都不输出，没法判断结果，所以手动轮询
  $deadline = (Get-Date).AddSeconds($seconds)
  while ($true) {
    try { $proc.Refresh() } catch { return $true }
    if ($proc.HasExited) { return $true }
    if ((Get-Date) -gt $deadline) { return $false }
    Start-Sleep -Seconds 2
  }
}

function Get-LlamaPorts {
  $ports = @()
  try {
    $lines = Get-CimInstance Win32_Process -Filter "Name = 'llama-server.exe'" | Select-Object -ExpandProperty CommandLine
    foreach ($line in $lines) { if ($line -match '--port\s+(\d+)') { $ports += [int]$Matches[1] } }
  } catch { }
  return ($ports | Sort-Object -Unique)
}

function Get-LlamaServerInfo {
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
  if ($commandLine -match "--port\s+$llamaOwnPort") { return $true }
  if ($apiKey -and $commandLine -match [regex]::Escape($apiKey)) { return $true }
  if ($chatTemplate -and $commandLine -match [regex]::Escape($chatTemplate)) { return $true }
  return $false
}

function Dedupe-LlamaServers {
  $servers = @(Get-LlamaServerInfo)
  if ($servers.Count -le 1) { Write-Host "llama-server instances: $($servers.Count) (no duplicate)"; return }
  $own   = @($servers | Where-Object { Test-OwnLlamaInstance $_.CommandLine })
  $other = @($servers | Where-Object { -not (Test-OwnLlamaInstance $_.CommandLine) })
  if ($other.Count -gt 0) {
    $otherUp = @($other | Where-Object { $_.Port -gt 0 -and (Test-Port $_.Port) })
    if ($otherUp.Count -gt 0) {
      foreach ($p in $own) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
      Write-Host "removed $($own.Count) redundant direct llama-server instance(s); kept managed llama-server (port $($otherUp[0].Port))"; return
    }
  }
  if ($own.Count -gt 1) {
    $keep = $own | Where-Object { $_.Port -eq $llamaOwnPort } | Select-Object -First 1
    if (-not $keep) { $keep = $own[0] }
    foreach ($p in $own | Where-Object { $_.ProcessId -ne $keep.ProcessId }) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    Write-Host "removed $($own.Count - 1) duplicate direct llama-server instance(s); kept pid $($keep.ProcessId)"; return
  }
  Write-Host "llama-server instances: $($servers.Count) (no duplicate)"
}

function Get-Vram {
  $s = nvidia-smi --query-gpu=memory.used,memory.free --format=csv,noheader 2>$null
  if ($s) { "VRAM used/free (MiB): $s" } else { 'VRAM: n/a' }
}

function Stop-TextModel {
  $id = Get-LoadedModelId
  if ($id) { Write-LastModelId $id } else { Write-LastModelId '' }
  # LM Studio 托管的模型先优雅卸载，避免直接强杀后 lms 状态残留、恢复时卡住
  $managed = $false
  try {
    $servers = @(Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'")
    foreach ($s in $servers) {
      $par = Get-CimInstance Win32_Process -Filter "ProcessId=$($s.ParentProcessId)" -ErrorAction SilentlyContinue
      if ($par -and $par.Name -eq 'LM Studio.exe') { $managed = $true; break }
    }
  } catch { }
  if ($managed -and $lmsCli) {
    try {
      Write-Host 'unloading text model via lms (graceful)'
      $up = Start-Process -FilePath $lmsCli -ArgumentList @('unload', '--all') -WindowStyle Hidden -PassThru
      $null = Wait-ProcExited $up 30
    } catch { }
    Start-Sleep -Seconds 2
  }
  $procs = Get-Process -Name llama-server -ErrorAction SilentlyContinue
  if ($procs) { $procs | Stop-Process -Force; Write-Host "text model stopped ($($procs.Count) process)" } else { Write-Host 'text model not running' }
  Start-Sleep -Seconds 3
}

function Start-TextModel {
  Dedupe-LlamaServers
  $running = @(Get-LlamaPorts | Where-Object { Test-Port $_ })
  if ($running.Count) { Write-Host "llama-server already running (port $($running -join ','))"; return }

  # 优先用 lms（LM Studio）恢复，最通用
  if ($lmsCli) {
    # 上次记录的模型必须校验真实存在（脏串会被丢弃），否则退回配置里的默认模型
    $model = Find-ValidModelId (Read-LastModelId)
    if (-not $model) { $model = Find-ValidModelId $modelId }
    if (-not $model) {
      try {
        $list = Get-LmsModels
        $llms = @($list | Where-Object { "$($_.type)".ToLower() -notmatch 'embedding' })
        $filter = Cfg 'localModelFilter' ''
        $cand = @($llms | Where-Object { $k = "$($_.indexedModelIdentifier) $($_.path) $($_.modelKey) $($_.displayName)"; (-not $filter) -or ($k -match [regex]::Escape($filter)) })
        if ($cand.Count) { $model = if ($cand[0].indexedModelIdentifier) { $cand[0].indexedModelIdentifier } else { $cand[0].modelKey } }
      } catch { }
    }
    if ($model) {
      Write-Host "restoring text model via lms: $model"
      $sp = Start-Process -FilePath $lmsCli -ArgumentList @('server', 'start') -WindowStyle Hidden -PassThru
      $null = Wait-ProcExited $sp 30
      # 模型 id 含空格，Start-Process -ArgumentList 数组会把空格拆成多个参数（lms 报 too many arguments），必须整体加引号
      $lp = Start-Process -FilePath $lmsCli -ArgumentList ('load "' + $model + '"') -WindowStyle Hidden -PassThru
      if (-not (Wait-ProcExited $lp 300)) {
        Write-Host 'lms load timed out; killing it'
        Stop-Process -Id $lp.Id -Force -ErrorAction SilentlyContinue
      }
      Start-Sleep -Seconds 2
      $up = @(Get-LlamaPorts | Where-Object { Test-Port $_ })
      if ($up.Count) { Write-Host "text model restored (port $($up -join ','))"; return }
      Write-Host 'lms restore did not bring up a server; falling back to direct launch'
    }
    else { Write-Host 'no usable model id found via lms; falling back to direct launch' }
  }

  # ---- 直启 llama-server（兜底） ----
  if (-not $llamaExe) { throw '未找到 llama-server.exe，请在 config.local.json 里设置 localLlamaExe' }
  if (-not $modelPath) { throw '未配置本地模型，请在 config.local.json 里设置 localModelPath' }
  if ($cudaVendor) { $env:Path = "$cudaVendor;$env:Path" }
  $args = @('--model', "`"$modelPath`"", '--host', '127.0.0.1', '--port', "$llamaOwnPort")
  if ($mmproj)      { $args += '--mmproj', "`"$mmproj`"" }
  if ($apiKey)      { $args += '--api-key', $apiKey }
  if ($chatTemplate){ $args += '--chat-template-file', "`"$chatTemplate`"" }
  $args += '--ctx-size', "$ctxSize", '--n-gpu-layers', "$gpuLayers", '--threads', "$threads", '--no-webui', '--jinja', '--parallel', '1'
  if ($extraArgs) { $args += ($extraArgs -split '\s+') }
  $p = Start-Process -FilePath $llamaExe -ArgumentList $args -WindowStyle Hidden -PassThru
  Write-Host "starting llama-server (pid $($p.Id)), waiting for port $llamaOwnPort..."
  if (Wait-Port $llamaOwnPort 90) { Write-Host 'llama-server up' } else { throw 'llama-server failed to start' }
}

function Start-Comfy {
  if (Test-Port $comfyPort) { Write-Host "ComfyUI already running (port $comfyPort)"; return $null }
  if (-not $comfyPy) { throw '未找到 ComfyUI 的 python，请在 config.local.json 里设置 comfyPy' }
  if (-not $comfyDir) { throw '未配置 ComfyUI 目录，请在 config.local.json 里设置 comfyDir' }
  $p = Start-Process -FilePath $comfyPy -ArgumentList @('main.py', '--listen', '127.0.0.1', '--port', "$comfyPort", '--lowvram') -WorkingDirectory $comfyDir -WindowStyle Hidden -PassThru
  Write-Host "starting ComfyUI (pid $($p.Id)), waiting for port $comfyPort..."
  if (Wait-Port $comfyPort 120) { Write-Host 'ComfyUI up'; return $p } else { throw 'ComfyUI failed to start' }
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
    Write-Host "comfy ${comfyPort}: $(if (Test-Port $comfyPort) { 'UP' } else { 'down' })"
    Get-Vram
  }
  'dedupe' { Dedupe-LlamaServers; Get-Vram }
  'to-text' { Stop-ComfyAny; Start-TextModel; Get-Vram }
  'to-image' { Stop-TextModel; $null = Start-Comfy; Get-Vram }
  'generate' {
    if (-not $Prompt) { throw 'generate needs a prompt' }
    if (-not $Out) { $Out = Join-Path ([Environment]::GetFolderPath('Desktop')) ("whale-img-$(Get-Date -Format 'yyyyMMdd-HHmmss').png") }
    if (-not $comfyCli) { throw '未配置 ComfyUI 生图入口，请在 config.local.json 里设置 comfyCli' }
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
