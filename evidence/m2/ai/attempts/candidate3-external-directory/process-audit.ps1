$OutputEncoding=[Text.UTF8Encoding]::new($false)
$ErrorActionPreference='Stop'
$root=(Get-Location).Path
$alive=@(Get-CimInstance Win32_Process|Where-Object { $_.Name -match '^(node|chrome|esbuild)\.exe$' -and $_.CommandLine -and $_.CommandLine.Contains($root) })
$data=@{remainingFlowProcesses=@($alive|Select-Object ProcessId,ParentProcessId,Name,CommandLine);passed=($alive.Count -eq 0);browserPolicy='Playwright browser.close executed in finally in each browser script; no flow browser profile processes remain'}
$data|ConvertTo-Json -Depth 6|Set-Content -Encoding UTF8 '.\report\process-audit.json'
if($alive.Count -gt 0){$alive|Format-List;throw 'Own processes remain'}
Write-Output 'No flow-owned Node, esbuild, or Chromium process remains.'
