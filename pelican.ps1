[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments=$true)][string[]]$CliArguments)
$ErrorActionPreference = 'Stop'
$engineDirectory = $PSScriptRoot
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$nodeExecutable = if ($nodeCommand) { $nodeCommand.Source } else { $null }
$nodeCompatible = $false
if ($nodeExecutable) { $nodeCompatible = ((& $nodeExecutable --version) -match '^v24\.') }
if (-not $nodeCompatible) {
  $nodeVersion = '24.15.0'
  $toolchainDirectory = Join-Path $engineDirectory '.pelican/toolchain'
  $archiveName = "node-v$nodeVersion-win-x64.zip"
  $localNodeDirectory = Join-Path $toolchainDirectory "node-v$nodeVersion-win-x64"
  $nodeExecutable = Join-Path $localNodeDirectory 'node.exe'
  if (-not (Test-Path -LiteralPath $nodeExecutable)) {
    New-Item -ItemType Directory -Force -Path $toolchainDirectory | Out-Null
    $archivePath = Join-Path $toolchainDirectory $archiveName
    $downloadBase = "https://nodejs.org/dist/v$nodeVersion"
    Invoke-WebRequest -UseBasicParsing -Uri "$downloadBase/$archiveName" -OutFile $archivePath
    $checksumText = (Invoke-WebRequest -UseBasicParsing -Uri "$downloadBase/SHASUMS256.txt").Content
    $checksumLine = ($checksumText -split "`n" | Where-Object { $_.Trim().EndsWith($archiveName) } | Select-Object -First 1)
    if (-not $checksumLine) { throw 'TC_SETUP_CHECKSUM_MISSING: Official Node checksum is missing.' }
    $expectedChecksum = ($checksumLine -split '\s+')[0].ToLowerInvariant()
    if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedChecksum) { throw 'TC_SETUP_CHECKSUM_MISMATCH: Node download checksum failed.' }
    Expand-Archive -LiteralPath $archivePath -DestinationPath $toolchainDirectory -Force
  }
}
$nodeDirectory = Split-Path -Parent $nodeExecutable
$env:PATH = $nodeDirectory + [IO.Path]::PathSeparator + $env:PATH
$tsxEntry = Join-Path $engineDirectory 'node_modules/tsx/dist/cli.mjs'
if (-not (Test-Path -LiteralPath $tsxEntry)) {
  $npmEntry = Join-Path $nodeDirectory 'node_modules/npm/bin/npm-cli.js'
  if (-not (Test-Path -LiteralPath $npmEntry)) { throw 'TC_SETUP_NPM_MISSING: Selected Node distribution has no npm. Use the official Node archive.' }
  & $nodeExecutable $npmEntry --prefix $engineDirectory ci --prefer-offline --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
& $nodeExecutable $tsxEntry (Join-Path $engineDirectory 'tools/cli.ts') @CliArguments
exit $LASTEXITCODE
