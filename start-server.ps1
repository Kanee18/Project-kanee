# One-click launcher: starts the backend + Cloudflare tunnel (which auto-
# publishes its public URL to Firestore so the deployed chat app finds it).
# Each runs in its own window so you can read logs / Ctrl+C individually.
#
#   Right-click → "Run with PowerShell"   (or:  ./start-server.ps1)
#
# Uses -WorkingDirectory (handles paths with spaces) instead of cd inside the
# spawned command, so it works even though this folder has spaces in its name.

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$backend = Join-Path $root "backend"

# --- 1. (optional) GPT-SoVITS ------------------------------------------------
# Point this at your GPT-SoVITS folder to start it here as well. Leave commented
# to start it yourself.
# $SovitsDir = "C:\path\to\GPT-SoVITS"
# if ($SovitsDir) {
#   Start-Process powershell -WorkingDirectory $SovitsDir -ArgumentList `
#     '-NoExit','-Command','python api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml'
# }

# --- 2. Backend (FastAPI) ----------------------------------------------------
Start-Process powershell -WorkingDirectory $backend -ArgumentList `
  '-NoExit','-Command','py -m uvicorn main:app --port 8000'

# --- 3. Cloudflare tunnel + publish URL to Firestore -------------------------
Start-Process powershell -WorkingDirectory $backend -ArgumentList `
  '-NoExit','-Command','py serve_tunnel.py'

Write-Host "Launched backend + tunnel in separate windows." -ForegroundColor Green
Write-Host "Make sure GPT-SoVITS is running too (port 9880)." -ForegroundColor Yellow
