$OutputEncoding=[Text.UTF8Encoding]::new($false)
$ErrorActionPreference='Stop'
$archive='C:\Users\60459\AppData\Local\Temp\threecat M2 ZIP 中文 Xys1mN\threecat-m2-input.zip'
$hash=(Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if($hash -ne '23951c241183e834ccd3fcf76ea629b725e24f44cce8dc352ce9c29cc4d0737c'){throw 'Candidate3 ZIP hash mismatch'}
if(Test-Path -LiteralPath '.\candidate3'){throw 'candidate3 exists'}
Expand-Archive -LiteralPath $archive -DestinationPath '.\candidate3'
Write-Output "candidate3 archiveSHA $hash verified and extracted"
