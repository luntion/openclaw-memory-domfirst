$ErrorActionPreference = "Stop"

function Test-HttpJson {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$Label
  )

  try {
    $response = Invoke-RestMethod -Uri $Url -Method Get -TimeoutSec 10
    Write-Host "[ok] $Label -> $Url"
    return $response
  } catch {
    Write-Host "[fail] $Label -> $Url"
    Write-Host $_.Exception.Message
    return $null
  }
}

$neo4jUri = $env:OCM_NEO4J_URI
if (-not $neo4jUri) { $neo4jUri = "bolt://127.0.0.1:7687" }
$graphitiUrl = $env:OCM_GRAPHITI_URL
if (-not $graphitiUrl) { $graphitiUrl = "http://127.0.0.1:8000" }
$memorydUrl = $env:OCM_MEMORYD_URL
if (-not $memorydUrl) { $memorydUrl = "http://127.0.0.1:42690" }

Write-Host "Checking OpenClaw Memory DomFirst backend..."
Write-Host "Neo4j URI:   $neo4jUri"
Write-Host "Graphiti:    $graphitiUrl"
Write-Host "Memoryd:     $memorydUrl"
Write-Host ""

$graphiti = Test-HttpJson -Url "$graphitiUrl/healthcheck" -Label "Graphiti service"
$memoryd = Test-HttpJson -Url "$memorydUrl/health" -Label "ocm-memoryd"

try {
  $boltTarget = $neo4jUri -replace "^bolt\\+s?://", "" -replace "^neo4j\\+s?://", ""
  $host, $port = $boltTarget.Split(":", 2)
  if (-not $port) { $port = "7687" }
  $probe = Test-NetConnection -ComputerName $host -Port ([int]$port) -WarningAction SilentlyContinue
  if ($probe.TcpTestSucceeded) {
    Write-Host "[ok] Neo4j Bolt reachable -> $host`:$port"
  } else {
    Write-Host "[fail] Neo4j Bolt unreachable -> $host`:$port"
  }
} catch {
  Write-Host "[fail] Neo4j URI parse failed -> $neo4jUri"
}

Write-Host ""
if ($memoryd -and $memoryd.backend) {
  Write-Host "Memory backend health payload:"
  $memoryd.backend | ConvertTo-Json -Depth 8
}
