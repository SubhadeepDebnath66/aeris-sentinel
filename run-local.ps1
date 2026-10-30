$ErrorActionPreference = 'Stop'
$port = 8080
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "Starting Ares at http://localhost:$port/"
Write-Host "Keep this window open while using the simulation. Press Ctrl+C to stop."
python -m http.server $port --directory $root
