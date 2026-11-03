# Pinned CPU inference runtime for Windows Cutout. No runtime network access.
# Dot-source, then call Sync-WindowsCutout <directory beside producer.exe>.
function Sync-WindowsCutout([string]$Destination) {
  $version = '1.23.2'
  $hash = '0b38df9af21834e41e73d602d90db5cb06dbd1ca618948b8f1d66d607ac9f3cd'
  $cache = Join-Path ([IO.Path]::GetTempPath()) "producer-cutout-$version"
  New-Item -ItemType Directory -Path $cache -Force | Out-Null
  $zip = Join-Path $cache "onnxruntime-win-x64-$version.zip"
  if (-not (Test-Path -LiteralPath $zip)) {
    Invoke-WebRequest "https://github.com/microsoft/onnxruntime/releases/download/v$version/onnxruntime-win-x64-$version.zip" -OutFile $zip
  }
  if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash) {
    throw 'Windows Cutout runtime checksum mismatch'
  }
  $runtime = Join-Path $cache "onnxruntime-win-x64-$version"
  if (-not (Test-Path -LiteralPath "$runtime\lib\onnxruntime.dll")) { Expand-Archive -LiteralPath $zip -DestinationPath $cache -Force }
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  foreach ($name in @('onnxruntime.dll','onnxruntime_providers_shared.dll')) {
    Copy-Item -LiteralPath "$runtime\lib\$name" -Destination $Destination -Force
  }
  $licenses = Join-Path $Destination 'licenses\cutout'
  New-Item -ItemType Directory -Path $licenses -Force | Out-Null
  foreach ($name in @('LICENSE','ThirdPartyNotices.txt')) {
    Copy-Item -LiteralPath "$runtime\$name" -Destination (Join-Path $licenses "onnxruntime-$name") -Force
  }
  $model = Join-Path $PSScriptRoot '..\src-tauri\src\live\vendor\pphumanseg'
  Copy-Item -LiteralPath "$model\LICENSE" -Destination "$licenses\pphumanseg-LICENSE" -Force
  Copy-Item -LiteralPath "$model\README.md" -Destination "$licenses\pphumanseg-README.md" -Force
}
