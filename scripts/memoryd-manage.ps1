param(
  [ValidateSet("start", "stop", "status", "restart")]
  [string]$Action = "start"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $root ".runtime"
$pidPath = Join-Path $runtimeDir "memoryd.pid"
$logPath = Join-Path $runtimeDir "memoryd.log"
$servicePort = 42690

function Ensure-RuntimeDir {
  if (-not (Test-Path $runtimeDir)) {
    New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
  }
}

function Get-PidValue {
  if (-not (Test-Path $pidPath)) { return $null }
  $raw = (Get-Content -Raw $pidPath).Trim()
  if (-not $raw) { return $null }
  try { return [int]$raw } catch { return $null }
}

function Get-ServiceCandidates {
  Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq "node.exe" -and
    $null -ne $_.CommandLine -and
    $_.CommandLine -match [regex]::Escape($root) -and
    $_.CommandLine -match "service\.ts"
  }
}

function Get-DescendantProcess {
  param(
    [int]$ParentProcessId,
    [int]$Depth = 0
  )

  if ($Depth -gt 6) { return $null }

  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $ParentProcessId")
  foreach ($child in $children) {
    if (
      $child.Name -eq "node.exe" -and
      $null -ne $child.CommandLine -and
      $child.CommandLine -match [regex]::Escape($root) -and
      $child.CommandLine -match "service\.ts"
    ) {
      return $child
    }
    $descendant = Get-DescendantProcess -ParentProcessId $child.ProcessId -Depth ($Depth + 1)
    if ($descendant) {
      return $descendant
    }
  }

  return $null
}

function Get-DescendantProcesses {
  param([int]$ParentProcessId)

  $results = @()
  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $ParentProcessId")
  foreach ($child in $children) {
    $results += $child
    $results += @(Get-DescendantProcesses -ParentProcessId $child.ProcessId)
  }
  return $results
}

function Get-ManagedAncestors {
  param([Microsoft.Management.Infrastructure.CimInstance]$Process)

  $ancestors = @()
  $current = $Process
  for ($depth = 0; $depth -lt 6; $depth++) {
    if (-not $current.ParentProcessId -or $current.ParentProcessId -le 0) { break }
    try {
      $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($current.ParentProcessId)"
    } catch {
      break
    }
    if ($null -eq $parent) { break }
    if (
      ($parent.Name -eq "cmd.exe" -or $parent.Name -eq "powershell.exe" -or $parent.Name -eq "pwsh.exe") -and
      $null -ne $parent.CommandLine -and
      $parent.CommandLine -match [regex]::Escape($root) -and
      $parent.CommandLine -match "service\.ts"
    ) {
      $ancestors += $parent
      $current = $parent
      continue
    }
    break
  }
  return $ancestors
}

function Resolve-ServiceProcess {
  param([int]$BootstrapPid)

  $byTree = Get-DescendantProcess -ParentProcessId $BootstrapPid
  if ($byTree) {
    return $byTree
  }

  $candidates = @(Get-ServiceCandidates | Sort-Object ProcessId -Descending)
  if ($candidates.Count -gt 0) {
    return $candidates[0]
  }

  return $null
}

function Write-ManagedPid {
  param([int]$ProcessId)
  Set-Content -Path $pidPath -Value $ProcessId -NoNewline
}

function Get-ManagedProcess {
  $managedPid = Get-PidValue
  if ($managedPid) {
    try {
      $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $managedPid"
      if (
        $null -ne $proc -and
        $proc.Name -eq "node.exe" -and
        $null -ne $proc.CommandLine -and
        $proc.CommandLine -match [regex]::Escape($root) -and
        $proc.CommandLine -match "service\.ts"
      ) {
        return $proc
      }
    } catch {
    }
  }

  $fallback = Resolve-ServiceProcess -BootstrapPid 0
  if ($fallback) {
    Write-ManagedPid -ProcessId $fallback.ProcessId
    return $fallback
  }

  return $null
}

function Wait-Health {
  param([int]$Attempts = 20, [int]$DelaySeconds = 2)
  for ($i = 1; $i -le $Attempts; $i++) {
    try {
      Invoke-RestMethod -Uri "http://127.0.0.1:$servicePort/health" -Method Get -TimeoutSec 10 | Out-Null
      return $true
    } catch {
      Start-Sleep -Seconds $DelaySeconds
    }
  }
  return $false
}

function Start-Memoryd {
  Ensure-RuntimeDir

  if (-not (Test-Path (Join-Path $root "node_modules"))) {
    Write-Host "Installing dependencies..."
    npm install
  }

  $existing = Get-ManagedProcess
  if ($existing) {
    Write-Host "memoryd already running (PID=$($existing.ProcessId))"
    return
  }

  $command = @(
    "Set-Location '$root'"
    "`$env:OCM_BACKEND_MODE='graphiti-neo4j'"
    "`$env:OCM_GRAPHITI_URL='http://127.0.0.1:18000'"
    "`$env:OCM_NEO4J_URI='bolt://127.0.0.1:7687'"
    "`$env:OCM_NEO4J_USER='neo4j'"
    "`$env:OCM_NEO4J_PASSWORD='reflection123'"
    "`$env:OCM_NEO4J_DATABASE='neo4j'"
    "`$env:OCM_NEO4J_WORKSPACE='main'"
    "npm run service *>> '$logPath'"
  ) -join "; "

  $proc = Start-Process -FilePath "powershell" `
    -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $command `
    -WindowStyle Hidden `
    -PassThru

  if (Wait-Health) {
    $serviceProc = $null
    for ($i = 0; $i -lt 20; $i++) {
      $serviceProc = Resolve-ServiceProcess -BootstrapPid $proc.Id
      if ($serviceProc) { break }
      Start-Sleep -Milliseconds 500
    }

    if ($serviceProc) {
      Write-ManagedPid -ProcessId $serviceProc.ProcessId
      Write-Host "memoryd started (PID=$($serviceProc.ProcessId))"
      return
    }

    Write-Host "memoryd became healthy, but the service PID could not be resolved"
    return
  }

  Write-Host "memoryd failed to become healthy"
  if (Test-Path $logPath) {
    Get-Content -Tail 120 $logPath
  }
  throw "memoryd did not pass health check"
}

function Stop-Memoryd {
  $proc = Get-ManagedProcess
  if (-not $proc) {
    Write-Host "memoryd is not running"
    if (Test-Path $pidPath) { Remove-Item $pidPath -Force }
    return
  }

  $descendants = @(Get-DescendantProcesses -ParentProcessId $proc.ProcessId | Sort-Object ProcessId -Descending)
  foreach ($child in $descendants) {
    Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue
  }

  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue

  $ancestors = @(Get-ManagedAncestors -Process $proc)
  foreach ($ancestor in $ancestors) {
    Stop-Process -Id $ancestor.ProcessId -Force -ErrorAction SilentlyContinue
  }

  Start-Sleep -Seconds 2
  if (Test-Path $pidPath) { Remove-Item $pidPath -Force }
  Write-Host "memoryd stopped"
}

function Show-Status {
  $proc = Get-ManagedProcess
  if (-not $proc) {
    Write-Host "memoryd status: stopped"
    return
  }
  Write-Host "memoryd status: running (PID=$($proc.ProcessId))"
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$servicePort/health" -Method Get -TimeoutSec 10
    $health | ConvertTo-Json -Depth 10
  } catch {
    Write-Host "health check failed: $($_.Exception.Message)"
  }
}

switch ($Action) {
  "start" { Start-Memoryd }
  "stop" { Stop-Memoryd }
  "status" { Show-Status }
  "restart" {
    Stop-Memoryd
    Start-Memoryd
  }
}
