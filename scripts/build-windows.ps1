# build-windows.ps1 -- production Windows installer WITH the live engine.
#
#   .\scripts\build-windows.ps1            # NSIS installer under src-tauri\target\release\bundle\nsis\
#   .\scripts\build-windows.ps1 -Smoke     # ...then silent-install it to %TEMP% and boot the engine once
#
# What ships: producer.exe linked against the engine for the current
# engine/obs.lock (build.rs sees PRODUCER_ENGINE_DIR), plus the engine itself
# flattened beside the exe (src-tauri/tauri.windows.conf.json bundles
# engine/windows-bundle/ into the install root). Updater artifacts are emitted
# only when TAURI_SIGNING_PRIVATE_KEY is set (release CI); a local build skips
# them rather than failing on the missing key. Code signing is not wired: the
# installer is unsigned and SmartScreen will say so.
param([switch]$Smoke, [string]$SmokeOutputDir = "$env:TEMP\producer-windows-installed-proof")
. "$PSScriptRoot\windows-engine.ps1"

$eng = Get-EngineDir
Test-EngineGate $eng
$stage = Sync-WindowsBundle $eng
$env:PRODUCER_ENGINE_DIR = $eng

Push-Location $RepoRoot
try {
  # Build-only config, as a FILE (PowerShell 5.1 strips quotes from inline JSON on
  # the way to a native exe). The engine staging dir is mapped here and not in
  # tauri.windows.conf.json on purpose: tauri-build validates every resource
  # path at cargo build time, and CI's engine-less cargo check has no staging
  # dir. A DIRECTORY source is walked with its structure preserved; a glob
  # source is flattened to bare file names (tauri-utils resources.rs).
  $cfgObj = @{ bundle = @{ resources = @{ "windows-bundle" = "./" } } }
  if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
    Write-Host "TAURI_SIGNING_PRIVATE_KEY not set: building without updater artifacts"
    $cfgObj.bundle.createUpdaterArtifacts = $false
  }
  $cfg = Join-Path $env:TEMP "producer-local-build.json"
  Set-Content -Path $cfg -Value ($cfgObj | ConvertTo-Json -Depth 5 -Compress) -Encoding Ascii
  # Match the ARM64 Mac release: native guest ingress and program publication
  # must be compiled in, not silently replaced by the legacy browser transport.
  $args = @("run", "tauri", "build", "--features", "guest-rtc-production", "--bundles", "nsis", "--config", $cfg)
  & bun @args
  if ($LASTEXITCODE -ne 0) { throw "tauri build failed" }

  $targetDir = Get-CargoTargetDir
  $exe = Join-Path $targetDir "release\producer.exe"
  # Proof the exe is the engine build: it imports obs.dll by name.
  $bytes = [System.IO.File]::ReadAllBytes($exe)
  $txt = [System.Text.Encoding]::ASCII.GetString($bytes)
  if ($txt -notmatch "obs\.dll") { throw "producer.exe does not import obs.dll -- this is an engine-less build (PRODUCER_ENGINE_DIR=$eng)" }
  Write-Host "producer.exe imports obs.dll: engine build confirmed"

  $inst = Get-ChildItem (Join-Path $targetDir "release\bundle\nsis") -Filter "*.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $inst) { throw "no NSIS installer produced" }
  Write-Host ("installer: {0} ({1:N0} MB)" -f $inst.FullName, ($inst.Length / 1MB))

  if ($Smoke) {
    & "$PSScriptRoot\test-windows-installed.ps1" -Installer $inst.FullName -ExpectedExecutable $exe -OutputDir $SmokeOutputDir
  }
} finally { Pop-Location }
