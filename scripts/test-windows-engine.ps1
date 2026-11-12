# Engine-backed acceptance checks. Each GPU test runs in its own process
# because libobs/CEF have process-global initialization and teardown.
param(
  [Parameter(Mandatory=$true)][string]$EngineDir,
  [string]$OutputDir = "$env:TEMP\producer-windows-runtime-proof",
  [switch]$PrepareOnly,
  [switch]$RunOnly,
  [ValidateRange(60,1200)][int]$MaxRuntimeSeconds = 1140
)
$ErrorActionPreference = 'Stop'
if ($PrepareOnly -and $RunOnly) { throw 'Choose PrepareOnly or RunOnly' }
$repo = (Resolve-Path -LiteralPath "$PSScriptRoot\..").Path
$EngineDir = (Resolve-Path -LiteralPath $EngineDir).Path
$engineBin = if (Test-Path -LiteralPath "$EngineDir\bin\obs.dll") { "$EngineDir\bin" } else { $EngineDir }
if (-not (Test-Path -LiteralPath "$engineBin\obs.dll")) { throw 'Engine directory does not contain obs.dll' }
$env:PRODUCER_ENGINE_DIR = $EngineDir
$env:PATH = "$engineBin;$env:PATH"
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
$OutputDir = (Resolve-Path -LiteralPath $OutputDir).Path
$preparedPath = Join-Path $OutputDir 'prepared-tests.json'
$features = 'guest-rtc-production,tauri/custom-protocol'
$tests = @(
  'windows_native_set_and_portrait_lifecycle',
  'windows_gpu_presets_compile_and_render',
  'obs_program_tap_copies_timestamped_video_and_stage_audio_then_disconnects',
  'windows_dual_recordings_finalize_with_video_and_audio',
  'native_dual_clips_start_rearm_and_save_without_audio_sources',
  'windows_native_guest_ingress_and_retirement',
  'windows_cutout_and_virtual_camera_pixels_and_lifecycle'
)
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
  $source = (& git rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $source) { throw 'Could not identify qualification source' }
  $engineHash = (Get-FileHash -LiteralPath "$engineBin\obs.dll" -Algorithm SHA256).Hash.ToLowerInvariant()
  if (-not $RunOnly) {
    # Build once outside the bounded runtime phase; preserve Cargo's exact
    # artifact receipt instead of choosing an old executable by filename/mtime.
    $messages = Join-Path $OutputDir 'cargo-artifacts.jsonl'
    & cargo test --manifest-path src-tauri/Cargo.toml --features $features --lib --no-run --message-format=json | Set-Content -LiteralPath $messages -Encoding UTF8
    if ($LASTEXITCODE -ne 0) { throw 'Windows engine-backed test compilation failed' }
    $artifacts = @(Get-Content -LiteralPath $messages | ForEach-Object {
      try { $item = $_ | ConvertFrom-Json } catch { $item = $null }
      if ($item -and $item.reason -eq 'compiler-artifact' -and $item.profile.test -and $item.executable -and $item.target.name -eq 'producer_lib') { $item.executable }
    } | Select-Object -Unique)
    if ($artifacts.Count -ne 1) { throw 'Expected exactly one current library-test executable from Cargo' }
    $testExe = (Resolve-Path -LiteralPath $artifacts[0]).Path
    [ordered]@{ source=$source; features=$features; engineSha256=$engineHash; executable=$testExe; executableSha256=(Get-FileHash -LiteralPath $testExe -Algorithm SHA256).Hash.ToLowerInvariant() } |
      ConvertTo-Json | Set-Content -LiteralPath $preparedPath -Encoding UTF8
  }
  if ($PrepareOnly) { Write-Output 'PASS: engine-backed Windows test executable prepared'; return }
  $prepared = Get-Content -LiteralPath $preparedPath -Raw | ConvertFrom-Json
  $testExe = (Resolve-Path -LiteralPath $prepared.executable).Path
  if ($prepared.source -ne $source -or $prepared.features -ne $features -or $prepared.engineSha256 -ne $engineHash -or $prepared.executableSha256 -ne (Get-FileHash -LiteralPath $testExe -Algorithm SHA256).Hash.ToLowerInvariant()) {
    throw 'Prepared test binary, source or native engine changed'
  }
  if (-not (Get-Command ffprobe -ErrorAction SilentlyContinue)) { throw 'ffprobe is required for dual-recording qualification' }
  $receipt = [ordered]@{ schema='producer.windows-runtime-proof/1'; source=$source; features=$features; engineSha256=$engineHash; status='failed'; tests=@() }
  $deadline = [DateTime]::UtcNow.AddSeconds($MaxRuntimeSeconds)
  function Invoke-Proof([string]$Name, [string[]]$Arguments, [int]$Seconds) {
    $remaining = [int][Math]::Floor(($deadline - [DateTime]::UtcNow).TotalSeconds)
    if ($remaining -le 0) { throw 'Windows qualification runtime budget exhausted' }
    $Seconds = [Math]::Min($Seconds, $remaining)
    $stdout = Join-Path $OutputDir "$Name.stdout.log"
    $stderr = Join-Path $OutputDir "$Name.stderr.log"
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $p = Start-Process -FilePath $testExe -ArgumentList $Arguments -WorkingDirectory $repo -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    $case = [ordered]@{ name=$Name; status='failed'; timedOut=$false }
    try {
      $null = $p.Handle
      if (-not $p.WaitForExit($Seconds * 1000)) {
        $case.timedOut = $true
        & taskkill.exe /PID $p.Id /T /F 2>$null | Out-Null
        throw "Windows native proof $Name exceeded ${Seconds}s"
      }
      $case.exitCode = $p.ExitCode
      if ($p.ExitCode -ne 0) { throw "Windows native proof $Name failed ($($p.ExitCode)); see proof logs" }
      $text = Get-Content -LiteralPath $stdout -Raw
      if ($Name -ne 'ignored-test-list') {
        $expected = if ($Name -eq 'unit-tests') { 'test result: ok\. [1-9][0-9]* passed;' } else { 'test result: ok\. 1 passed;' }
        if ($text -notmatch $expected) { throw "Windows native proof $Name did not actually execute the expected tests" }
      }
      $case.status = 'passed'
      return $text
    } finally {
      $case.durationMs = [Math]::Round($clock.Elapsed.TotalMilliseconds)
      $receipt.tests += $case
      $receipt | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $OutputDir 'runtime-proof.json') -Encoding UTF8
    }
  }
  try {
    Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion, AdapterCompatibility |
      ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $OutputDir 'adapters.json') -Encoding UTF8
    # Filtering by a missing test is a successful zero-test Rust invocation.
    # Enumerate first and require every exact engine-backed case to exist.
    $listed = Invoke-Proof 'ignored-test-list' @('--list','--ignored') 30
    $names = @($listed -split "`r?`n" | Where-Object { $_ -match ': test$' } | ForEach-Object { $_ -replace ': test$','' })
    $exact = @{}
    foreach ($test in $tests) {
      $matchedTests = @($names | Where-Object { $_ -match ('(^|::)' + [regex]::Escape($test) + '$') })
      if ($matchedTests.Count -ne 1) { throw "Missing or ambiguous native test $test; engine-backed build required" }
      $exact[$test] = $matchedTests[0]
    }
    $null = Invoke-Proof 'unit-tests' @('--test-threads=1') 180
    foreach ($test in $tests) {
      $null = Invoke-Proof $test @('--exact',$exact[$test],'--ignored','--test-threads=1','--nocapture') 180
    }
    $receipt.status = 'passed'
  } finally {
    $receipt | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $OutputDir 'runtime-proof.json') -Encoding UTF8
  }
} finally { Pop-Location }
