# Engine-backed acceptance checks. Each GPU test runs in its own process
# because libobs/CEF have process-global initialization and teardown.
param([Parameter(Mandatory=$true)][string]$EngineDir)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath "$PSScriptRoot\..").Path
$EngineDir = (Resolve-Path -LiteralPath $EngineDir).Path
$engineBin = if (Test-Path -LiteralPath "$EngineDir\bin\obs.dll") { "$EngineDir\bin" } else { $EngineDir }
if (-not (Test-Path -LiteralPath "$engineBin\obs.dll")) { throw 'Engine directory does not contain obs.dll' }
$env:PRODUCER_ENGINE_DIR = $EngineDir
$env:PATH = "$engineBin;$env:PATH"
Push-Location $repo
try {
  $metadata = cargo metadata --manifest-path src-tauri/Cargo.toml --no-deps --format-version 1 | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw 'Could not resolve Cargo target directory' }
  $testBin = Join-Path $metadata.target_directory 'debug\deps'
  New-Item -ItemType Directory -Path $testBin -Force | Out-Null
  . "$PSScriptRoot\windows-cutout.ps1"
  Sync-WindowsCutout $testBin
  # OBS launches hardware probes and the mux helper beside the host executable.
  Get-ChildItem -LiteralPath $engineBin -File -Filter 'obs-*.exe' | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $testBin -Force
  }
  $cargoArgs = @('test','--manifest-path','src-tauri/Cargo.toml','--features','guest-rtc-production,tauri/custom-protocol','--lib')
  & cargo @cargoArgs
  if ($LASTEXITCODE -ne 0) { throw 'Windows native guest unit tests failed' }
  foreach ($test in @(
    'windows_cutout_and_virtual_camera_pixels_and_lifecycle',
    'windows_gpu_presets_compile_and_render',
    'windows_native_set_and_portrait_lifecycle',
    'windows_native_guest_ingress_and_retirement',
    'obs_program_tap_copies_timestamped_video_and_stage_audio_then_disconnects',
    'windows_dual_recordings_finalize_with_video_and_audio'
  )) {
    & cargo @cargoArgs $test -- --ignored --test-threads=1 --nocapture
    if ($LASTEXITCODE -ne 0) { throw "Windows native acceptance failed: $test" }
  }
} finally { Pop-Location }
