param(
  [string]$EngineDir = "$env:LOCALAPPDATA\Producer",
  [string]$OutputDir = "$env:TEMP\producer-windows-native-proof",
  [switch]$CompileOnly
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath "$PSScriptRoot\..").Path
$EngineDir = (Resolve-Path -LiteralPath $EngineDir).Path
if (-not (Test-Path -LiteralPath "$EngineDir\obs.lib")) { throw 'Engine import library obs.lib is required' }
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw 'Visual Studio C++ Build Tools are required' }
# Import the compiler environment into this process; never print its values.
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
$OutputDir = (Resolve-Path -LiteralPath $OutputDir).Path
$envScript = Join-Path $OutputDir 'compiler-env.cmd'
Set-Content -LiteralPath $envScript -Encoding Ascii -Value @(
  '@echo off',
  "call `"$vs\VC\Auxiliary\Build\vcvars64.bat`" >nul",
  'if errorlevel 1 exit /b 1',
  'set'
)
$compilerEnv = & $env:ComSpec /d /c $envScript
if ($LASTEXITCODE -ne 0) { throw 'Visual Studio compiler environment failed' }
foreach ($entry in $compilerEnv) {
  if ($entry -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') }
}
$sources = @('group','scene','transition','program','readiness','chart') | ForEach-Object { "$repo\src-tauri\src\live\sets_v2\$_.c" }
$sources += "$repo\src-tauri\src\live\source_appearance.c"
Push-Location $OutputDir
try {
  & cl.exe /nologo /std:c11 /experimental:c11atomics /W3 /we4013 "/I$repo\src-tauri\src\live" "$repo\scripts\sets-v2\windows-native-probe.c" @sources "/Fe$OutputDir\probe.exe" /link "$EngineDir\obs.lib"
  if ($LASTEXITCODE -ne 0) { throw 'Windows native probe compile/link failed' }
  if ($CompileOnly) { Write-Output 'PASS: Windows native compositor compile/link'; return }
  $env:PATH = "$EngineDir;$env:PATH"
  New-Item -ItemType Directory -Path "$OutputDir\config" -Force | Out-Null
  & "$OutputDir\probe.exe" $EngineDir "$OutputDir\config"
  if ($LASTEXITCODE -ne 0) { throw "Windows native probe failed ($LASTEXITCODE)" }
} finally { Pop-Location }
