# Airi stage-web dev server startup script

$AiriRoot = Join-Path $PSScriptRoot "airi"

# Find pnpm (Scoop -> npm global -> PATH)
function Find-Pnpm {
    $candidates = @(
        (Join-Path $env:USERPROFILE "scoop\shims\pnpm.exe"),
        (Join-Path $env:USERPROFILE "scoop\shims\pnpm.cmd"),
        (Join-Path $env:USERPROFILE "scoop\shims\pnpm.ps1"),
        (Join-Path $env:APPDATA "npm\pnpm.cmd"),
        (Join-Path $env:APPDATA "npm\pnpm.ps1")
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { return $c }
    }
    $inPath = Get-Command pnpm -ErrorAction SilentlyContinue
    if ($inPath) { return $inPath.Source }
    return $null
}

$PnpmCmd = Find-Pnpm

Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "  Airi stage-web Dev Server" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host ""

if (-not $PnpmCmd) {
    Write-Host "[ERROR] pnpm not found." -ForegroundColor Red
    Write-Host "  Install: scoop install nodejs  OR  npm install -g pnpm" -ForegroundColor Gray
    exit 1
}
Write-Host "[OK] pnpm: $PnpmCmd" -ForegroundColor DarkGray

# Check .env.secret
$SecretFile = Join-Path $PSScriptRoot "airi\apps\stage-web\.env.secret"
if (Test-Path $SecretFile) {
    $content = Get-Content $SecretFile -Raw
    if ($content -match "VITE_GEMINI_API_KEY=(.+)") {
        $key = $Matches[1].Trim()
        if ($key -and $key -ne "") {
            Write-Host "[OK] GEMINI_API_KEY is set" -ForegroundColor Green
        }
        else {
            Write-Host "[WARN] VITE_GEMINI_API_KEY is empty in .env.secret" -ForegroundColor Yellow
            Write-Host "  Edit: notepad `"$SecretFile`"" -ForegroundColor Gray
        }
    }
    else {
        Write-Host "[WARN] VITE_GEMINI_API_KEY not found in .env.secret" -ForegroundColor Yellow
    }
}
else {
    Write-Host "[WARN] .env.secret not found - starting without API key" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "[START] http://localhost:5173  (Ctrl+C to stop)" -ForegroundColor Green
Write-Host ""

Push-Location $AiriRoot
& $PnpmCmd -F @proj-airi/stage-web dev
Pop-Location
