$OutputEncoding=[Text.UTF8Encoding]::new($false)
$ErrorActionPreference='Stop'
$root=(Get-Location).Path
$stopped=@()
$servers=@((Get-Content -Raw -Encoding UTF8 '.\report-candidate5\dev-server.json'|ConvertFrom-Json),(Get-Content -Raw -Encoding UTF8 '.\report-candidate5\static-server.json'|ConvertFrom-Json))
foreach($server in $servers){
  $all=@(Get-CimInstance Win32_Process)
  $owner=$all|Where-Object ProcessId -eq $server.pid
  if($owner){
    if(-not $owner.CommandLine.Contains($root)){throw "PID $($server.pid) is not flow-owned"}
    $ids=[Collections.Generic.List[int]]::new()
    $ids.Add([int]$server.pid)
    for($i=0;$i -lt $ids.Count;$i++){foreach($child in ($all|Where-Object ParentProcessId -eq $ids[$i])){$ids.Add([int]$child.ProcessId)}}
    for($i=$ids.Count-1;$i -ge 0;$i--){$processId=$ids[$i];Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue;$stopped+= $processId}
  }
}
$ports=@()
foreach($server in $servers){$client=[Net.Sockets.TcpClient]::new();try{$client.Connect('127.0.0.1',[int]$server.port);throw "Own server port $($server.port) remains open"}catch [Net.Sockets.SocketException]{$ports+=@{port=$server.port;closed=$true}}finally{$client.Dispose()}}
@{stoppedPids=$stopped;ports=$ports;scope='Only verified flow-owned dev/static process trees'}|ConvertTo-Json -Depth 6|Set-Content -Encoding UTF8 '.\report-candidate5\cleanup.json'
Write-Output "Closed own servers and verified both listening ports closed. PIDs: $stopped"
