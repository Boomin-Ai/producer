# dev-windows.ps1 -- Producer dev loop on Windows WITH the live engine.
#
#   .\scripts\dev-windows.ps1            # tauri dev: Vite HMR + debug exe + engine
#   .\scripts\dev-windows.ps1 -Build     # just build the debug exe (no launch)
#
# The engine for the current engine/obs.lock is fetched from CI if missing and
# proved by the closure gate. producer.exe resolves obs.dll from PATH in dev
# (the bundle flattens bin/ beside the exe instead), and the engine root is
# handed over by PRODUCER_ENGINE_DIR. Unlike macOS there is no bundle
# requirement for CEF on Windows: `tauri dev` renders browser sources.
param([switch]$Build)
. "$PSScriptRoot\windows-engine.ps1"

$eng = Get-EngineDir
Test-EngineGate $eng
$env:PRODUCER_ENGINE_DIR = $eng
$env:PATH = "$eng\bin;" + $env:PATH
Write-Host "engine: $eng"

Push-Location $RepoRoot
try {
  # OBS resolves encoder probes AND the recording muxer beside the executable.
  # PATH is enough for engine DLLs, but not these explicitly resolved helpers.
  # The installer flattens bin/ there; dev must stage the same subprocesses.
  $dbg = Join-Path (Get-CargoTargetDir) "debug"
  New-Item -ItemType Directory -Force $dbg | Out-Null
  Sync-WindowsCutout $dbg
  $helpers = @(Sync-WindowsDevHelpers -EngineDir $eng -OutputDir $dbg)
  Write-Host "Windows runtime helpers beside the dev exe: $($helpers -join ', ')"
  if ($Build) {
    cargo build --manifest-path src-tauri\Cargo.toml --features guest-rtc-production
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }
    Write-Host "debug exe: $dbg\producer.exe (run with PATH=$eng\bin)"
  } else {
    bun run tauri dev --features guest-rtc-production
  }
} finally { Pop-Location }
