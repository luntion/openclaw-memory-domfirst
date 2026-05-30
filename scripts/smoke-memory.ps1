$ErrorActionPreference = "Stop"

function Invoke-Json {
  param(
    [Parameter(Mandatory = $true)][ValidateSet("GET", "POST")][string]$Method,
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter()][object]$Body
  )

  if ($Method -eq "GET") {
    return Invoke-RestMethod -Uri $Url -Method Get -TimeoutSec 20
  }

  $json = if ($null -eq $Body) { "{}" } else { $Body | ConvertTo-Json -Depth 10 }
  return Invoke-RestMethod -Uri $Url -Method Post -TimeoutSec 30 -ContentType "application/json" -Body $json
}

function Wait-HttpReady {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [int]$Attempts = 20,
    [int]$DelaySeconds = 2
  )

  for ($i = 1; $i -le $Attempts; $i++) {
    try {
      Invoke-RestMethod -Uri $Url -Method Get -TimeoutSec 10 | Out-Null
      return
    } catch {
      if ($i -eq $Attempts) { throw }
      Start-Sleep -Seconds $DelaySeconds
    }
  }
}

$memorydUrl = $env:OCM_MEMORYD_URL
if (-not $memorydUrl) { $memorydUrl = "http://127.0.0.1:42690" }

$ctx = @{
  sessionId = "smoke-session"
  agentId = "smoke-agent"
  projectId = "smoke-project"
  teamId = "smoke-team"
}

Write-Host "Running OpenClaw Memory DomFirst smoke test..."
Write-Host "Memoryd: $memorydUrl"
Write-Host ""

Wait-HttpReady -Url "$memorydUrl/health"

$health = Invoke-Json -Method GET -Url "$memorydUrl/health"
Write-Host "[1/5] Health"
$health | ConvertTo-Json -Depth 10
Write-Host ""

Write-Host "[2/5] Ingest sample event"
$sampleMessage = @{
  role = "user"
  content = "Yesterday we hit a skill build failure in openclaw-memory-domfirst. The root cause was a missing Neo4j index bootstrap, and we fixed it by adding automatic schema initialization during backend startup."
}
$ingest = Invoke-Json -Method POST -Url "$memorydUrl/ingest" -Body @{
  ctx = $ctx
  message = $sampleMessage
}
$ingest | ConvertTo-Json -Depth 10
Write-Host ""

Write-Host "Waiting for afterTurn extraction..."
Start-Sleep -Seconds 2
Write-Host ""

Write-Host "[3/5] Confirmation-style recall (expected shallow)"
$searchL1 = Invoke-Json -Method POST -Url "$memorydUrl/search" -Body @{
  ctx = $ctx
  query = "Yesterday we hit that skill build failure, right?"
}
$searchL1.displayText
Write-Host ""

Write-Host "[4/5] Detail-style recall (expected deeper)"
$searchL3 = Invoke-Json -Method POST -Url "$memorydUrl/search" -Body @{
  ctx = $ctx
  query = "What exactly was the skill build failure yesterday and how did we fix it?"
}
$searchL3.displayText
Write-Host ""

Write-Host "[5/5] Combined diagnostics"
$diagnostics = Invoke-Json -Method GET -Url "$memorydUrl/diagnostics?sessionId=smoke-session&agentId=smoke-agent&projectId=smoke-project&teamId=smoke-team"
$diagnostics.displayText
Write-Host ""
Write-Host "Smoke test finished."
