$OutputEncoding=[Text.UTF8Encoding]::new($false)
$ErrorActionPreference='Stop'
$archive='C:\Users\60459\AppData\Local\Temp\threecat M2 ZIP 中文 e8oeJn\threecat-m2-input.zip'
$hash=(Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if($hash -ne '0caf155c8c8047dd8c3020cd3f7824f156c6dbf4d1233936e7c1b2bafb45a905'){throw 'Final ZIP hash mismatch'}
Expand-Archive -LiteralPath $archive -DestinationPath '.\new-candidate'
$source=(Resolve-Path -LiteralPath '.\new-candidate\threecat').Path
$target=Join-Path (Get-Location).Path 'engine'
if(-not $source.StartsWith((Get-Location).Path+[IO.Path]::DirectorySeparatorChar)){throw 'Unsafe move source'}
if(Test-Path -LiteralPath $target){throw 'engine already exists'}
Move-Item -LiteralPath $source -Destination $target
Write-Output "Final archiveSHA $hash; engine extracted"
