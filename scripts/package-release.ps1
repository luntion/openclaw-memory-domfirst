$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$pkg = Get-Content "package.json" | ConvertFrom-Json
$name = $pkg.name
$version = $pkg.version
$releaseDir = Join-Path $root "release"
$stageDir = Join-Path $releaseDir "$name-$version"
$archivePath = Join-Path $releaseDir "$name-$version.zip"

if (Test-Path $stageDir) {
  Remove-Item -Recurse -Force $stageDir
}

if (Test-Path $archivePath) {
  Remove-Item -Force $archivePath
}

New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
New-Item -ItemType Directory -Force -Path $stageDir | Out-Null

$paths = @(
  "index.ts",
  "service.ts",
  "openclaw.plugin.json",
  "package.json",
  "package-lock.json",
  "README.md",
  "README_CN.md",
  "CHANGELOG.md",
  "LICENSE",
  "tsconfig.json",
  "vitest.config.ts",
  "src",
  "docs",
  "scripts"
)

foreach ($path in $paths) {
  if (Test-Path $path) {
    Copy-Item -Recurse -Force $path (Join-Path $stageDir $path)
  }
}

$manifest = @{
  name = $name
  version = $version
  packagedAt = (Get-Date).ToString("s")
  included = $paths
} | ConvertTo-Json -Depth 5

$manifest | Set-Content -Path (Join-Path $stageDir "release-manifest.json") -Encoding UTF8

Compress-Archive -Path (Join-Path $stageDir "*") -DestinationPath $archivePath -Force

Write-Host "Created release artifact: $archivePath"
