param([Parameter(Mandatory=$true)][string]$ConfigPath)
$ErrorActionPreference = 'Stop'
$bridgeConfigPath = (Resolve-Path -LiteralPath $ConfigPath).Path
$bridgeConfig = Get-Content -LiteralPath $bridgeConfigPath -Raw | ConvertFrom-Json
if ($bridgeConfig.peer -ne 'windows') { throw 'Windows installer requires peer=windows' }
$bridgeScript = Join-Path $PSScriptRoot 'client.mjs'
$bridgeNode = (Get-Command node.exe).Source
$bridgeState = [System.IO.Path]::GetFullPath($bridgeConfig.stateDir)
if (-not (Test-Path -LiteralPath $bridgeState -PathType Container)) { throw 'Initialize the private state directory first' }
$bridgeLauncher = Join-Path $bridgeState 'start-bridge.ps1'
$quotedNode = $bridgeNode.Replace("'", "''")
$quotedScript = $bridgeScript.Replace("'", "''")
$quotedConfig = $bridgeConfigPath.Replace("'", "''")
$quotedState = $bridgeState.Replace("'", "''")
$bridgeLauncherText = @"
`$ErrorActionPreference = 'Stop'
Start-Process -FilePath '$quotedNode' -ArgumentList @('`"$quotedScript`"', '`"$quotedConfig`"') -WindowStyle Hidden -RedirectStandardOutput '$quotedState\listener.stdout.log' -RedirectStandardError '$quotedState\listener.stderr.log'
"@
Set-Content -LiteralPath $bridgeLauncher -Value $bridgeLauncherText -Encoding utf8
$bridgePowerShell = (Get-Process -Id $PID).Path
$bridgeRunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
New-Item -Path $bridgeRunKey -Force | Out-Null
$bridgeStartCommand = '"' + $bridgePowerShell + '" -NoProfile -WindowStyle Hidden -File "' + $bridgeLauncher + '"'
New-ItemProperty -Path $bridgeRunKey -Name 'ProducerAgentBridge' -Value $bridgeStartCommand -PropertyType String -Force | Out-Null
& $bridgeLauncher
'Windows bridge started hidden and registered for this user at sign-in.'
