$OutputEncoding=[Text.UTF8Encoding]::new($false)
$ErrorActionPreference='Stop'
$root=(Get-Location).Path
$env:PLAYWRIGHT_BROWSERS_PATH='C:\Users\60459\AppData\Local\ms-playwright'
$env:TEMP=Join-Path $root 'cache\tmp'
$env:TMP=$env:TEMP
$listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
$listener.Start()
$port=$listener.LocalEndpoint.Port
$listener.Stop()
$tsx=Join-Path $root 'candidate5\threecat\node_modules\tsx\dist\cli.mjs'
$cli=Join-Path $root 'candidate5\threecat\tools\cli.ts'
$game=Join-Path $root '外部游戏 空格'
$proc=Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList @(('"'+$tsx+'"'),('"'+$cli+'"'),'dev','--project',('"'+$game+'"'),'--port',"$port") -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $root 'report-candidate5\dev.stdout.txt') -RedirectStandardError (Join-Path $root 'report-candidate5\dev.stderr.txt') -PassThru
@{pid=$proc.Id;port=$port;url="http://localhost:$port";engine='candidate5/threecat';project='外部游戏 空格'} | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath '.\report-candidate5\dev-server.json'
Write-Output "Started isolated dev PID $($proc.Id) at port $port"
