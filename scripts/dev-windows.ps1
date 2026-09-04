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
  # The hardware-encoder plugins run obs-nvenc-test.exe / obs-qsv-test.exe /
  # obs-amf-test.exe from the EXECUTABLE's directory (the installer flattens
  # bin/ beside producer.exe). The dev exe lives in target\debug, so without
  # this copy every probe fails and a GPU box silently streams x264.
  $dbg = Join-Path $RepoRoot "src-tauri\target\debug"
  New-Item -ItemType Directory -Force $dbg | Out-Null
  Get-ChildItem (Join-Path $eng "bin") -Filter "obs-*-test.exe" | ForEach-Object { Copy-Item $_.FullName $dbg -Force }
  Write-Host "encoder probe helpers beside the dev exe: $((Get-ChildItem $dbg -Filter 'obs-*-test.exe').Name -join ', ')"
  if ($Build) {
    cargo build --manifest-path src-tauri\Cargo.toml
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }
    Write-Host "debug exe: src-tauri\target\debug\producer.exe (run with PATH=$eng\bin)"
  } else {
    bun run tauri dev
  }
} finally { Pop-Location }
