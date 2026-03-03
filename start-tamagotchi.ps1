# Airi stage-tamagotchi (Electron) dev server startup script

$AiriRoot = Join-Path $PSScriptRoot "airi"

# Find pnpm
function Find-Pnpm {
    $candidates = @(
        (Join-Path $env:USERPROFILE "scoop\shims\pnpm.exe"),
        (Join-Path $env:USERPROFILE "scoop\shims\pnpm.cmd"),
        (Join-Path $env:APPDATA "npm\pnpm.cmd")
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { return $c }
    }
    $inPath = Get-Command pnpm -ErrorAction SilentlyContinue
    if ($inPath) { return $inPath.Source }
    return $null
}

# .env.local 파싱 함수
function Get-EnvValue($filePath, $key) {
    if (-not (Test-Path $filePath)) { return $null }
    $line = Get-Content $filePath | Where-Object { $_ -match "^\s*$key\s*=" } | Select-Object -Last 1
    if ($line) { return ($line -split "=", 2)[1].Trim() }
    return $null
}

$PnpmCmd = Find-Pnpm

Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "  Airi stage-tamagotchi (Electron)" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host ""

if (-not $PnpmCmd) {
    Write-Host "[ERROR] pnpm not found." -ForegroundColor Red
    exit 1
}
Write-Host "[OK] pnpm: $PnpmCmd" -ForegroundColor DarkGray

# Check .env.secret
$SecretFile = Join-Path $PSScriptRoot "airi\apps\stage-tamagotchi\.env.local"
if (-not (Test-Path $SecretFile)) {
    # Fallback: copy from stage-web
    $WebSecret = Join-Path $PSScriptRoot "airi\apps\stage-web\.env.local"
    if (Test-Path $WebSecret) {
        Copy-Item $WebSecret $SecretFile
        Write-Host "[INFO] Copied .env.local from stage-web" -ForegroundColor DarkGray
    }
}

# ── TTS 서버 자동 실행 ────────────────────────────────────────────────
$EdgeTtsProcess = $null
$TtsProvider = Get-EnvValue $SecretFile "VITE_TTS_PROVIDER"

if ($TtsProvider -eq "openai-compatible-audio-speech") {
    $EdgeTtsServerPath = Join-Path $PSScriptRoot "airi\apps\stage-tamagotchi\edge-tts-server.py"

    if (Test-Path $EdgeTtsServerPath) {
        # 현재 세션의 python 경로 직접 사용 (conda 환경 포함)
        $PythonCmd = (Get-Command python -ErrorAction SilentlyContinue).Source
        if (-not $PythonCmd) { $PythonCmd = "python" }

        # 포트 파싱 (VITE_TTS_BASE_URL=http://localhost:5050/v1/)
        $TtsBaseUrl = Get-EnvValue $SecretFile "VITE_TTS_BASE_URL"
        $TtsPort = 5050
        if ($TtsBaseUrl -match ":(\d+)") { $TtsPort = [int]$Matches[1] }

        # 이미 포트가 TCP LISTEN 상태면 스킵 (UDP/TIME_WAIT 제외)
        $existing = netstat -an 2>$null | Select-String "TCP\s+0\.0\.0\.0:$TtsPort\s+.*LISTENING"
        if ($existing) {
            Write-Host "[TTS] edge-tts server already running on :$TtsPort" -ForegroundColor DarkGray
        }
        else {
            Write-Host "[TTS] Starting edge-tts server ($PythonCmd) on :$TtsPort ..." -ForegroundColor Green
            $EdgeTtsProcess = Start-Process `
                -FilePath $PythonCmd `
                -ArgumentList $EdgeTtsServerPath `
                -WindowStyle Normal `
                -PassThru

            # 서버가 올라올 때까지 잠깐 대기
            Start-Sleep -Seconds 2
            if ($EdgeTtsProcess -and -not $EdgeTtsProcess.HasExited) {
                Write-Host "[TTS] edge-tts server started (PID: $($EdgeTtsProcess.Id))" -ForegroundColor Green
            }
            else {
                Write-Host "[TTS] WARNING: edge-tts server failed to start." -ForegroundColor Yellow
                $EdgeTtsProcess = $null
            }
        }
    }
    else {
        Write-Host "[TTS] WARNING: edge-tts-server.py not found, skipping." -ForegroundColor Yellow
    }
}

# Log path info
$LogPath = Join-Path $env:APPDATA "airi-tamagotchi\logs\llm.log"
Write-Host "[LOG] LLM logs  -> $LogPath" -ForegroundColor Green
$ChatLogPath = Join-Path $env:APPDATA "airi-tamagotchi\logs\chat.log"
Write-Host "[LOG] Chat logs -> $ChatLogPath" -ForegroundColor Green
Write-Host ""
Write-Host "[START] Electron dev mode  (Ctrl+C to stop)" -ForegroundColor Green
Write-Host ""

Push-Location $AiriRoot
try {
    & $PnpmCmd -F @proj-airi/stage-tamagotchi dev
}
finally {
    # Airi 종료 시 edge-tts 프로세스도 정리
    if ($EdgeTtsProcess -and -not $EdgeTtsProcess.HasExited) {
        Write-Host "`n[TTS] Stopping edge-tts server (PID: $($EdgeTtsProcess.Id))..." -ForegroundColor DarkGray
        Stop-Process -Id $EdgeTtsProcess.Id -Force -ErrorAction SilentlyContinue
    }
    Pop-Location
}

