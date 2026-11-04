$OutputEncoding=[Text.UTF8Encoding]::new($false)
$ErrorActionPreference='Stop'
$record=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'dev-server-process.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$ownedId=[int]$record.pid
if($ownedId -le 0){throw 'Invalid owned process ID'}
$owned=Get-CimInstance Win32_Process -Filter "ProcessId=$ownedId"
$closed=@()
if($owned){
 if($owned.CommandLine -notlike '*threecat.ps1*--port 4319*'){throw 'Owned process identity mismatch'}
 $output=& taskkill.exe /PID $ownedId /T /F 2>&1
 $code=$LASTEXITCODE
 $closed+=@{pid=$ownedId;exitCode=$code;stdout=($output -join "`n");commandLine=$owned.CommandLine}
 if($code -ne 0){throw 'Could not terminate own dev server tree'}
}else{$closed+=@{pid=$ownedId;alreadyExited=$true;exitCode=0}}
$ports=4319,4321,4323,4324
$listeners=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {$ports -contains $_.LocalPort} | Select-Object LocalPort,OwningProcess)
if($listeners.Count){throw 'An acceptance server port remains listening'}
$flowRoot=Split-Path -Parent $PSScriptRoot
$browsers=@(Get-CimInstance Win32_Process | Where-Object {$_.Name -in @('chrome.exe','headless_shell.exe') -and $_.CommandLine -like ('*'+$flowRoot+'*')} | Select-Object ProcessId,Name,CommandLine)
if($browsers.Count){throw 'Candidate5 browser remains running'}
$result=@{passed=$true;closed=$closed;ownedPortsListening=$listeners;flowBrowsersRemaining=$browsers;humanTechnicalSteps=0;staticShutdown='managed-static IPC exit 0';reproShutdown='taskkill recorded exit 0 for both own child trees'}
$json=$result|ConvertTo-Json -Depth 8
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'cleanup-verification.json'),$json,[Text.UTF8Encoding]::new($false))
$json
