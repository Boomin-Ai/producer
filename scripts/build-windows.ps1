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
param([switch]$Smoke)
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
  $args = @("run", "tauri", "build", "--bundles", "nsis", "--config", $cfg)
  & bun @args
  if ($LASTEXITCODE -ne 0) { throw "tauri build failed" }

  $exe = Join-Path $RepoRoot "src-tauri\target\release\producer.exe"
  # Proof the exe is the engine build: it imports obs.dll by name.
  $bytes = [System.IO.File]::ReadAllBytes($exe)
  $txt = [System.Text.Encoding]::ASCII.GetString($bytes)
  if ($txt -notmatch "obs\.dll") { throw "producer.exe does not import obs.dll -- this is an engine-less build (PRODUCER_ENGINE_DIR=$eng)" }
  Write-Host "producer.exe imports obs.dll: engine build confirmed"

  $inst = Get-ChildItem (Join-Path $RepoRoot "src-tauri\target\release\bundle\nsis") -Filter "*.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $inst) { throw "no NSIS installer produced" }
  Write-Host ("installer: {0} ({1:N0} MB)" -f $inst.FullName, ($inst.Length / 1MB))

  if ($Smoke) {
    $dir = Join-Path $env:TEMP "ProducerSmoke"
    if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
    Write-Host "silent install to $dir"
    $p = Start-Process $inst.FullName -ArgumentList "/S", "/D=$dir" -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw "installer exit $($p.ExitCode)" }
    foreach ($must in "producer.exe", "obs.dll", "obs-plugins\64bit\obs-browser.dll", "obs-plugins\64bit\Producer Helper.exe", "data\obs-plugins\win-dshow\obs-virtualcam-module64.dll", "data\obs-plugins\win-dshow\placeholder.png") {
      if (-not (Test-Path (Join-Path $dir $must))) { throw "installed tree is missing $must" }
    }
    Write-Host "installed tree carries the engine beside producer.exe"
    $log = Join-Path $env:TEMP "ProducerSmoke.log"
    $app = Start-Process (Join-Path $dir "producer.exe") -RedirectStandardError $log -PassThru -WorkingDirectory $dir
    Start-Sleep -Seconds 12
    $ok = Select-String -Path $log -Pattern "sdr white level|\[engine\]" -Quiet
    Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
    if (-not $ok) { Get-Content $log -Tail 20; throw "installed app did not boot the engine (see $log)" }
    Write-Host "installed app booted the engine (log: $log)"
    # Leave no second "Producer" on the machine: the smoke install registered
    # an uninstall entry and a Start Menu shortcut for currentUser.
    $un = Join-Path $dir "uninstall.exe"
    if (Test-Path $un) {
      $u = Start-Process $un -ArgumentList "/S" -Wait -PassThru
      Write-Host "smoke install removed (uninstaller exit $($u.ExitCode))"
    }
  }
} finally { Pop-Location }
