$OutputEncoding=[Text.UTF8Encoding]::new($false)
$ErrorActionPreference='Stop'
$root=(Get-Location).Path
$inputFile=Join-Path $root 'report-candidate5\empty.stdin.txt'
[IO.File]::WriteAllText($inputFile,'')
$file=Join-Path $root 'report-candidate5\static-server.cjs'
$proc=Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList ('"'+$file+'"') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardInput $inputFile -RedirectStandardOutput (Join-Path $root 'report-candidate5\static.stdout.txt') -RedirectStandardError (Join-Path $root 'report-candidate5\static.stderr.txt') -PassThru
Write-Output "Started independent static server PID $($proc.Id)"
