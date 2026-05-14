# Install Prewarning as a Windows service via NSSM.
#
# Run from an elevated PowerShell:
#   PS> Set-ExecutionPolicy -Scope Process Bypass
#   PS> .\install-nssm.ps1
#
# Requires:
#   - Node.js >= 20 in PATH (https://nodejs.org)
#   - NSSM in PATH (https://nssm.cc/download)  (or pass -NssmPath)

param(
  [string]$AppDir   = "C:\Prewarning",
  [string]$ConfDir  = "C:\Prewarning\config",
  [string]$LogDir   = "C:\Prewarning\logs",
  [string]$ServiceName = "Prewarning",
  [string]$NodePath = "",
  [string]$NssmPath = ""
)

$ErrorActionPreference = "Stop"

function Require-Admin {
  $current = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($current)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell (Run as Administrator)."
  }
}

function Resolve-Tool($preset, $name) {
  if ($preset) { return $preset }
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  throw "$name not found in PATH. Install it or pass the explicit path."
}

Require-Admin

$Node = Resolve-Tool $NodePath "node.exe"
$Nssm = Resolve-Tool $NssmPath "nssm.exe"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot   = Split-Path -Parent $scriptRoot

Write-Host "Copying application to $AppDir"
New-Item -ItemType Directory -Force -Path $AppDir, $ConfDir, $LogDir | Out-Null
robocopy $repoRoot $AppDir /MIR `
  /XD node_modules .git `
  /XF config.yml *.log | Out-Null

Push-Location $AppDir
try {
  Write-Host "Installing npm dependencies (production)"
  & npm ci --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) {
    & npm install --omit=dev --no-audit --no-fund
  }
} finally {
  Pop-Location
}

$cfgPath = Join-Path $ConfDir "config.yml"
if (-not (Test-Path $cfgPath)) {
  Copy-Item (Join-Path $repoRoot "config.example.yml") $cfgPath
  Write-Host ""
  Write-Host "  >>> Edit $cfgPath and fill in your MySQL details." -ForegroundColor Yellow
  Write-Host ""
} else {
  Write-Host "Existing $cfgPath preserved."
}

# Recreate the service idempotently.
$existing = & $Nssm status $ServiceName 2>$null
if ($LASTEXITCODE -eq 0) {
  Write-Host "Removing existing service $ServiceName"
  & $Nssm stop $ServiceName | Out-Null
  & $Nssm remove $ServiceName confirm | Out-Null
}

Write-Host "Installing $ServiceName as a Windows service via NSSM"
& $Nssm install $ServiceName $Node "$AppDir\src\index.js"
& $Nssm set $ServiceName AppDirectory $AppDir
& $Nssm set $ServiceName AppEnvironmentExtra "PREWARNING_CONFIG=$cfgPath" "NODE_ENV=production"
& $Nssm set $ServiceName AppStdout (Join-Path $LogDir "stdout.log")
& $Nssm set $ServiceName AppStderr (Join-Path $LogDir "stderr.log")
& $Nssm set $ServiceName AppRotateFiles 1
& $Nssm set $ServiceName AppRotateBytes 10485760
& $Nssm set $ServiceName Start SERVICE_AUTO_START
& $Nssm set $ServiceName AppRestartDelay 3000

Write-Host "Starting $ServiceName"
& $Nssm start $ServiceName

Write-Host ""
Write-Host "Prewarning installed." -ForegroundColor Green
Write-Host "  Status:  nssm status $ServiceName"
Write-Host "  Logs:    Get-Content -Wait '$LogDir\stdout.log'"
Write-Host "  Config:  $cfgPath"
Write-Host "  URL:     http://localhost:8080/"
