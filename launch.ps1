# Launcher for the Health Auto Export receiver + workout calendar.
#   1. Creates .venv and installs requirements on first run.
#   2. Stops any previous instance holding the port.
#   3. Starts uvicorn on 0.0.0.0 so the iPhone can reach it over Wi-Fi.
#   4. Prints the exact values to enter in Health Auto Export, then opens the calendar.
# Pass -NoBrowser to skip opening the browser (used by the startup task).
param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot
$Port = if ($env:HAE_PORT) { [int]$env:HAE_PORT } else { 8765 }
$Python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'

Write-Host "== Health Auto Export receiver ==" -ForegroundColor Cyan

if (-not (Test-Path $Python)) {
    Write-Host "Creating virtual environment..."
    python -m venv .venv
    & $Python -m pip install --quiet -r requirements.txt
}

# Stop a previous instance on our port.
$conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($ownerPid in @($conns | Select-Object -ExpandProperty OwningProcess -Unique)) {
    if ($ownerPid -gt 0) {
        Write-Host "Port $Port held by PID $ownerPid - stopping it"
        taskkill /F /T /PID $ownerPid 2>$null | Out-Null
    }
}

$logDir = Join-Path $PSScriptRoot 'data\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$server = Start-Process -FilePath $Python -PassThru -WindowStyle Hidden `
    -ArgumentList '-m', 'uvicorn', 'app.main:create_app', '--factory', '--host', '0.0.0.0', '--port', "$Port" `
    -RedirectStandardOutput (Join-Path $logDir 'server.out.log') `
    -RedirectStandardError (Join-Path $logDir 'server.err.log')

$healthy = $false
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    try {
        $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/v1/health" -TimeoutSec 2
        if ($r.status -eq 'ok') { $healthy = $true; break }
    } catch { }
}
if (-not $healthy) {
    Write-Host "ERROR: server did not start. See data\logs\server.err.log" -ForegroundColor Red
    exit 1
}

$ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.PrefixOrigin -in 'Dhcp', 'Manual' -and $_.IPAddress -notlike '169.*' } |
    Select-Object -First 1).IPAddress
$token = (Get-Content (Join-Path $PSScriptRoot 'data\ingest_token.txt') -ErrorAction SilentlyContinue | Select-Object -First 1)

Write-Host "Running (PID $($server.Id)). Calendar: http://localhost:$Port" -ForegroundColor Green
Write-Host ""
Write-Host "Health Auto Export -> REST API automation settings:" -ForegroundColor Cyan
Write-Host "  URL:     http://${ip}:$Port/api/v1/ingest/health-auto-export"
Write-Host "  Header:  Authorization = Bearer $token"
Write-Host "  Data: Workouts | Format: JSON | Export Version 2 | Batch requests: on"

if (-not $NoBrowser) { Start-Process "http://localhost:$Port" }
