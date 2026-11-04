$OutputEncoding=[Text.UTF8Encoding]::new($false)
$ErrorActionPreference='Stop'
$root=(Get-Location).Path
$inputFile=Join-Path $root 'report\empty.stdin.txt'
[IO.File]::WriteAllText($inputFile,'')
$file=Join-Path $root 'report\static-server.cjs'
$proc=Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList ('"'+$file+'"') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardInput $inputFile -RedirectStandardOutput (Join-Path $root 'report\static.stdout.txt') -RedirectStandardError (Join-Path $root 'report\static.stderr.txt') -PassThru
Write-Output "Started independent static server PID $($proc.Id)"
