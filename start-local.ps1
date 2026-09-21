$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$engineRoot = Join-Path $projectRoot "engine"
$venvRoot = Join-Path $projectRoot ".venv"
$pythonExe = Join-Path $venvRoot "Scripts\python.exe"

Write-Host "[1/4] 检查本地运行环境..." -ForegroundColor Cyan
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
  Write-Host "未找到 Python 3.10 或更高版本。请先从 https://www.python.org/downloads/ 安装 Python。" -ForegroundColor Red
  Read-Host "按回车键退出"
  exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "未找到 Node.js 22 或更高版本。请先从 https://nodejs.org/ 安装 Node.js。" -ForegroundColor Red
  Read-Host "按回车键退出"
  exit 1
}

if (-not (Test-Path -LiteralPath $pythonExe)) {
  Write-Host "[2/4] 首次创建语音识别环境..." -ForegroundColor Cyan
  & $pythonLauncher @pythonPrefix -m venv $venvRoot
}

Write-Host "[3/4] 安装或检查依赖（首次需要几分钟）..." -ForegroundColor Cyan
& $pythonExe -m pip install --disable-pip-version-check -q -r (Join-Path $engineRoot "requirements.txt")
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "node_modules"))) {
  Push-Location $projectRoot
  try { npm install } finally { Pop-Location }
}

Write-Host "[4/4] 启动本地转写引擎和网页..." -ForegroundColor Cyan
$engineOut = Join-Path $projectRoot ".local-engine.out.log"
$engineErr = Join-Path $projectRoot ".local-engine.err.log"
$webOut = Join-Path $projectRoot ".local-web.out.log"
$webErr = Join-Path $projectRoot ".local-web.err.log"
Start-Process -FilePath $pythonExe -ArgumentList @("-m", "uvicorn", "server:app", "--host", "127.0.0.1", "--port", "8765") -WorkingDirectory $engineRoot -WindowStyle Hidden -RedirectStandardOutput $engineOut -RedirectStandardError $engineErr
Start-Process -FilePath "npm.cmd" -ArgumentList @("run", "dev") -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $webOut -RedirectStandardError $webErr

Start-Sleep -Seconds 5
Start-Process "http://localhost:5173/"
Write-Host "已启动： http://localhost:5173/" -ForegroundColor Green
Write-Host "保持此窗口打开即可。按 Ctrl+C 不会删除任何数据。" -ForegroundColor DarkGray
Read-Host "使用结束后按回车键关闭此提示"
