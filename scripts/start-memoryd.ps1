$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Test-Path "node_modules")) {
  Write-Host "Installing dependencies..."
  npm install
}

Write-Host "Starting ocm-memoryd..."
npm run service
