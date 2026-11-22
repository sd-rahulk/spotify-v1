param([int]$ObjectPort = 4569)
$ErrorActionPreference = 'Stop'
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$adb = Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe'
& $adb reverse tcp:8081 tcp:8081
& $adb reverse tcp:4100 tcp:4100
if ($ObjectPort -gt 0) { & $adb reverse "tcp:$ObjectPort" "tcp:$ObjectPort" }
Write-Host 'Use http://localhost:4100 when pairing the selected Android device.'
