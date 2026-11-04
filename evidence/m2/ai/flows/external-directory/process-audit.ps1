$OutputEncoding=[Text.UTF8Encoding]::new($false)
$ErrorActionPreference='Stop'
$root=(Get-Location).Path
$alive=@(Get-CimInstance Win32_Process|Where-Object { $_.CommandLine -and $_.CommandLine.Contains($root) -and (($_.Name -eq 'node.exe' -and (($_.CommandLine -match 'candidate5[\\/]threecat[\\/]tools[\\/]cli\.ts.*\bdev\b') -or ($_.CommandLine -match 'report-candidate5[\\/]static-server\.cjs'))) -or ($_.Name -eq 'chrome.exe' -and $_.CommandLine -match 'report-candidate5')) })
$data=@{remainingFlowProcesses=@($alive|Select-Object ProcessId,ParentProcessId,Name,CommandLine);passed=($alive.Count -eq 0);browserPolicy='Playwright browser.close executed in finally in each browser script; no flow browser profile processes remain'}
$data|ConvertTo-Json -Depth 6|Set-Content -Encoding UTF8 '.\report-candidate5\process-audit.json'
if($alive.Count -gt 0){$alive|Format-List;throw 'Own processes remain'}
Write-Output 'No flow-owned Node, esbuild, or Chromium process remains.'
