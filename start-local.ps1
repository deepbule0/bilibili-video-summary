$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$engineRoot = Join-Path $projectRoot "engine"
$venvRoot = Join-Path $projectRoot ".venv"
$pythonExe = Join-Path $venvRoot "Scripts\python.exe"
$engineOut = Join-Path $projectRoot ".local-engine.out.log"
$engineErr = Join-Path $projectRoot ".local-engine.err.log"
$ollamaOut = Join-Path $projectRoot ".local-ollama.out.log"
$ollamaErr = Join-Path $projectRoot ".local-ollama.err.log"
$healthUrl = "http://127.0.0.1:8765/api/health"
$siteUrl = "https://bili-video-summary.purple-ox-8139.chatgpt.site/"
$summaryModel = if ($env:BILI_SUMMARY_MODEL) { $env:BILI_SUMMARY_MODEL } else { "qwen3.5:9b" }
$summaryModelSize = if ($summaryModel -eq "qwen3.5:27b") { "17 GB" } else { "6.6 GB" }
$appDataRoot = Join-Path $env:LOCALAPPDATA "BiliVideoSummary"
$cudaRuntimeRoot = Join-Path $appDataRoot "cuda-runtime-v3"

function Get-LocalEngineHealth {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 2
    if ($response.StatusCode -eq 200) {
      return $response.Content | ConvertFrom-Json
    }
  } catch {
    return $null
  }
  return $null
}

function Test-LocalEngine {
  return $null -ne (Get-LocalEngineHealth)
}

function Get-OllamaCommand {
  $command = Get-Command "ollama.exe" -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  foreach ($candidate in @(
    (Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"),
    (Join-Path $env:LOCALAPPDATA "Ollama\ollama.exe")
  )) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  return $null
}

function Test-OllamaServer {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:11434/api/version" -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Test-OllamaModel([string]$ollamaCommand) {
  if (-not $ollamaCommand -or -not (Test-OllamaServer)) { return $false }
  try {
    $models = & $ollamaCommand list 2>$null
    return [bool]($models -match [regex]::Escape($summaryModel))
  } catch {
    return $false
  }
}

function Install-OllamaSummaryModel {
  $ollamaCommand = Get-OllamaCommand
  if (-not $ollamaCommand) {
    $winget = Get-Command "winget.exe" -ErrorAction SilentlyContinue
    if (-not $winget) { throw "WinGet was not found, so Ollama could not be installed automatically." }
    Write-Host "Installing the free local summary engine..." -ForegroundColor Cyan
    & $winget.Source install --id Ollama.Ollama --exact --scope user --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "Ollama installation failed." }
    $ollamaCommand = Get-OllamaCommand
    if (-not $ollamaCommand) { throw "Ollama was installed but its command could not be found." }
  }

  if (-not (Test-OllamaServer)) {
    Start-Process -FilePath $ollamaCommand `
      -ArgumentList @("serve") `
      -WindowStyle Hidden `
      -RedirectStandardOutput $ollamaOut `
      -RedirectStandardError $ollamaErr
    for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
      Start-Sleep -Seconds 1
      if (Test-OllamaServer) { break }
    }
  }
  if (-not (Test-OllamaServer)) { throw "The local summary engine did not start." }

  if (-not (Test-OllamaModel $ollamaCommand)) {
    Write-Host "Downloading $summaryModel (about $summaryModelSize, first summary start only)..." -ForegroundColor Cyan
    & $ollamaCommand pull $summaryModel
    if ($LASTEXITCODE -ne 0) { throw "Qwen3.5 model download failed." }
  }
  if (-not (Test-OllamaModel $ollamaCommand)) { throw "Qwen3.5 model validation failed." }
  return $ollamaCommand
}

function Get-CudaRuntimeDirectories {
  if (-not (Test-Path -LiteralPath $cudaRuntimeRoot)) { return @() }
  $cublas = Get-ChildItem -LiteralPath $cudaRuntimeRoot -Recurse -File -Filter "cublas64_12.dll" -ErrorAction SilentlyContinue | Select-Object -First 1
  $cudnn = Get-ChildItem -LiteralPath $cudaRuntimeRoot -Recurse -File -Filter "cudnn64_9.dll" -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cublas -or -not $cudnn) { return @() }
  return @(Get-ChildItem -LiteralPath $cudaRuntimeRoot -Recurse -File -Filter "*.dll" | Select-Object -ExpandProperty DirectoryName -Unique)
}

function Stop-ExistingLocalEngine {
  $listener = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $listener) { return }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
  if ($process -and $process.Name -eq "python.exe" -and $process.CommandLine -match "uvicorn\s+server:app") {
    Stop-Process -Id $listener.OwningProcess -Force
    for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
      Start-Sleep -Milliseconds 250
      if (-not (Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue)) { return }
    }
  }
  if (Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue) {
    throw "Port 8765 is occupied by another program."
  }
}

function Stop-WithMessage([string]$message) {
  Write-Host ""
  Write-Host $message -ForegroundColor Red
  if (Test-Path -LiteralPath $engineErr) {
    Write-Host ""
    Write-Host "Recent engine log:" -ForegroundColor Yellow
    Get-Content -LiteralPath $engineErr -Tail 30
  }
  Write-Host ""
  Read-Host "Press Enter to close"
  exit 1
}

Write-Host "[1/6] Checking the local transcription engine..." -ForegroundColor Cyan
$existingHealth = Get-LocalEngineHealth
$nvidiaSmi = Get-Command "nvidia-smi.exe" -ErrorAction SilentlyContinue
$hasNvidiaGpu = $false
if ($nvidiaSmi) {
  & $nvidiaSmi.Path --query-gpu=name --format=csv,noheader 2>$null | Out-Null
  $hasNvidiaGpu = $LASTEXITCODE -eq 0
}

$runtimeDirectories = @(Get-CudaRuntimeDirectories)
$existingOllama = Get-OllamaCommand
$existingSummaryReady = Test-OllamaModel $existingOllama
if ($existingHealth -and $existingSummaryReady -and $existingHealth.summary_model -eq $summaryModel -and (($existingHealth.device -eq "cuda" -and $runtimeDirectories.Count -gt 0) -or -not $hasNvidiaGpu)) {
  Write-Host "The engine is already running on $($existingHealth.device)." -ForegroundColor Green
  Start-Process $siteUrl
  Read-Host "The engine is running in the background. Press Enter to close this message"
  exit 0
}

$pythonLauncher = $null
$pythonPrefix = @()
$bundledPython = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if (Test-Path -LiteralPath $bundledPython) {
  try {
    $version = & $bundledPython -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null
    $parts = $version.Trim().Split('.')
    if ([int]$parts[0] -eq 3 -and [int]$parts[1] -ge 10) {
      $pythonLauncher = $bundledPython
    }
  } catch {}
}

foreach ($name in @("python3", "python")) {
  if ($pythonLauncher) { break }
  $candidate = Get-Command $name -ErrorAction SilentlyContinue
  if ($candidate) {
    try {
      $version = & $candidate.Path -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null
      $parts = $version.Trim().Split('.')
      if ([int]$parts[0] -eq 3 -and [int]$parts[1] -ge 10) {
        $pythonLauncher = $candidate.Path
        break
      }
    } catch {}
  }
}

if (-not $pythonLauncher) {
  $pyLauncher = Get-Command py -ErrorAction SilentlyContinue
  if ($pyLauncher) {
    try {
      $version = & $pyLauncher.Path -3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null
      $parts = $version.Trim().Split('.')
      if ([int]$parts[0] -eq 3 -and [int]$parts[1] -ge 10) {
        $pythonLauncher = $pyLauncher.Path
        $pythonPrefix = @("-3")
      }
    } catch {}
  }
}

if (-not $pythonLauncher) {
  Stop-WithMessage "Python 3.10 or newer was not found. Install it from https://www.python.org/downloads/ and try again."
}

if (-not (Test-Path -LiteralPath $pythonExe)) {
  Write-Host "[2/6] Creating the speech recognition environment..." -ForegroundColor Cyan
  & $pythonLauncher @pythonPrefix -m venv $venvRoot
  if ($LASTEXITCODE -ne 0) {
    Stop-WithMessage "Could not create the Python environment."
  }
} else {
  Write-Host "[2/6] Reusing the existing speech recognition environment." -ForegroundColor DarkGray
}

Write-Host "[3/6] Installing or checking dependencies. The first run can take several minutes..." -ForegroundColor Cyan
& $pythonExe -m pip install --disable-pip-version-check -q -r (Join-Path $engineRoot "requirements.txt")
if ($LASTEXITCODE -ne 0) {
  Stop-WithMessage "Dependency installation failed. Check the network connection and try again."
}

if ($hasNvidiaGpu) {
  Write-Host "[4/6] Preparing GPU acceleration..." -ForegroundColor Cyan
  try {
    if ($runtimeDirectories.Count -eq 0) {
      & $pythonExe (Join-Path $engineRoot "setup_cuda_runtime.py") --runtime-root $cudaRuntimeRoot
      if ($LASTEXITCODE -ne 0) { throw "GPU runtime setup failed." }
      $runtimeDirectories = @(Get-CudaRuntimeDirectories)
    }
    if ($runtimeDirectories.Count -eq 0) { throw "Required CUDA DLL files were not found." }
    $env:PATH = ($runtimeDirectories + @($env:PATH)) -join ";"
    $env:WHISPER_DEVICE = "cuda"
    Write-Host "CUDA is ready. large-v3 will run on the NVIDIA GPU." -ForegroundColor Green
  } catch {
    $env:WHISPER_DEVICE = "cpu"
    Write-Host "GPU setup was unavailable; CPU fallback will be used: $($_.Exception.Message)" -ForegroundColor Yellow
  }
} else {
  Write-Host "[4/6] No compatible NVIDIA GPU detected; using CPU." -ForegroundColor DarkGray
  $env:WHISPER_DEVICE = "cpu"
}

Write-Host "[5/6] Preparing the Qwen3.5 local summary model..." -ForegroundColor Cyan
try {
  $ollamaCommand = Install-OllamaSummaryModel
  $env:SUMMARY_MODEL = $summaryModel
  Write-Host "$summaryModel is ready for GPU-accelerated local summaries." -ForegroundColor Green
} catch {
  Write-Host "The Qwen3.5 summary model is unavailable; the built-in fallback will be used: $($_.Exception.Message)" -ForegroundColor Yellow
}

if ($existingHealth) {
  Write-Host "Restarting the engine to enable $($env:WHISPER_DEVICE)..." -ForegroundColor Cyan
  Stop-ExistingLocalEngine
}

Write-Host "[6/6] Starting the local transcription engine..." -ForegroundColor Cyan
$env:HF_HUB_DISABLE_XET = "1"
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"
Start-Process -FilePath $pythonExe `
  -ArgumentList @("-m", "uvicorn", "server:app", "--host", "127.0.0.1", "--port", "8765") `
  -WorkingDirectory $engineRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $engineOut `
  -RedirectStandardError $engineErr

$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
  Start-Sleep -Seconds 1
  if (Test-LocalEngine) {
    $ready = $true
    break
  }
}

if (-not $ready) {
  Stop-WithMessage "The local transcription engine did not start."
}

Write-Host ""
Write-Host "Ready: http://127.0.0.1:8765" -ForegroundColor Green
Write-Host "Opening the Bilibili summary site..." -ForegroundColor Green
Start-Process $siteUrl
Write-Host ""
Read-Host "The engine is running in the background. Press Enter to close this message"
