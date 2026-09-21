$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$engineRoot = Join-Path $projectRoot "engine"
$venvRoot = Join-Path $projectRoot ".venv"
$pythonExe = Join-Path $venvRoot "Scripts\python.exe"
$engineOut = Join-Path $projectRoot ".local-engine.out.log"
$engineErr = Join-Path $projectRoot ".local-engine.err.log"
$healthUrl = "http://127.0.0.1:8765/api/health"
$siteUrl = "https://bili-video-summary.purple-ox-8139.chatgpt.site/"

function Test-LocalEngine {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
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

Write-Host "[1/4] Checking the local transcription engine..." -ForegroundColor Cyan
if (Test-LocalEngine) {
  Write-Host "The engine is already running." -ForegroundColor Green
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
  Write-Host "[2/4] Creating the speech recognition environment..." -ForegroundColor Cyan
  & $pythonLauncher @pythonPrefix -m venv $venvRoot
  if ($LASTEXITCODE -ne 0) {
    Stop-WithMessage "Could not create the Python environment."
  }
} else {
  Write-Host "[2/4] Reusing the existing speech recognition environment." -ForegroundColor DarkGray
}

Write-Host "[3/4] Installing or checking dependencies. The first run can take several minutes..." -ForegroundColor Cyan
& $pythonExe -m pip install --disable-pip-version-check -q -r (Join-Path $engineRoot "requirements.txt")
if ($LASTEXITCODE -ne 0) {
  Stop-WithMessage "Dependency installation failed. Check the network connection and try again."
}

Write-Host "[4/4] Starting the local transcription engine..." -ForegroundColor Cyan
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
