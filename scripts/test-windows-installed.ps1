# Installed production binary proof. Only run on a disposable hosted Windows
# runner: NSIS changes current-user shortcuts/registry and the firewall rule.
[CmdletBinding(DefaultParameterSetName='CompilerExecutable')]
param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true, ParameterSetName='CompilerExecutable')][string]$ExpectedExecutable,
  [Parameter(Mandatory=$true, ParameterSetName='PackagedHash')]
  [ValidateScript({ $_ -cmatch '\A[0-9a-f]{64}\z' })][string]$ExpectedPackagedSha256,
  [Parameter(ParameterSetName='PackagedHash')][switch]$Headless,
  [Parameter(Mandatory=$true)][string]$OutputDir
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'Installed qualification requires a disposable GitHub-hosted runner'
}
$Installer = (Resolve-Path -LiteralPath $Installer).Path
if ($PSCmdlet.ParameterSetName -eq 'CompilerExecutable') {
  $ExpectedExecutable = (Resolve-Path -LiteralPath $ExpectedExecutable).Path
}
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
$OutputDir = (Resolve-Path -LiteralPath $OutputDir).Path
$installDir = Join-Path $OutputDir 'installed'
if (Test-Path -LiteralPath $installDir) { throw 'Qualification install directory already exists' }
# Tauri/dirs uses SHGetKnownFolderPath. APPDATA environment overrides alone do
# not isolate its profile. A fresh hosted account and absent known-folder
# profiles establish isolation without editing a user's existing application.
$profiles = @(
  (Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'ai.boomin.producer'),
  (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ai.boomin.producer')
) | Select-Object -Unique
foreach ($profile in $profiles) {
  if (Test-Path -LiteralPath $profile) { throw 'Existing Producer profile: refusing installed smoke test' }
}
$receipt = [ordered]@{
  schema = 'producer.windows-installed-proof/1'
  status = 'failed'
  stage = 'adapter_inventory'
  source = $env:PRODUCER_SOURCE_SHA
  identityMode = $PSCmdlet.ParameterSetName
  reportMode = 'installed-gui-report'
  engineReport = $false
  installedBinaryMatches = $false
  engineDirectoryOverrideCleared = $false
}
if ($Headless) { $receipt.reportMode = 'installed-selftest' }
$app = $null
$installed = $false
function Wait-OwnedProcess($Process, [int]$Seconds, [string]$Label) {
  $null = $Process.Handle
  if (-not $Process.WaitForExit($Seconds * 1000)) {
    & taskkill.exe /PID $Process.Id /T /F 2>$null | Out-Null
    throw "$Label exceeded ${Seconds}s"
  }
  if ($Process.ExitCode -ne 0) { throw "$Label exited $($Process.ExitCode)" }
}
try {
  Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion, AdapterCompatibility |
    ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $OutputDir 'adapters.json') -Encoding UTF8
  $receipt.stage = 'install'
  $p = Start-Process -FilePath $Installer -ArgumentList @('/S', "/D=$installDir") -PassThru
  Wait-OwnedProcess $p 120 'NSIS install'
  $installed = $true
  $receipt.stage = 'installed_files'
  foreach ($must in @('producer.exe','uninstall.exe','obs.dll','obs-plugins\64bit\obs-browser.dll','obs-plugins\64bit\Producer Helper.exe','data\obs-plugins\win-dshow\obs-virtualcam-module64.dll','data\obs-plugins\win-dshow\placeholder.png')) {
    if (-not (Test-Path -LiteralPath (Join-Path $installDir $must))) { throw "Installed engine payload missing $must" }
  }
  $exe = Join-Path $installDir 'producer.exe'
  $receipt.stage = 'executable_identity'
  $installedHash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
  $receipt.executableSha256 = $installedHash
  if ($PSCmdlet.ParameterSetName -eq 'CompilerExecutable') {
    # Tauri CLI 2.11.4 patches the first UNK marker to NSS before bundling,
    # then restores the original compiler output. Reproduce just that patch on
    # our in-memory expected bytes before comparing the entire installed file.
    $compilerMarker = '__TAURI_BUNDLE_TYPE_VAR_UNK'
    $nsisMarker = [Text.Encoding]::ASCII.GetBytes('__TAURI_BUNDLE_TYPE_VAR_NSS')
    $expectedBytes = [IO.File]::ReadAllBytes($ExpectedExecutable)
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
      $receipt.compilerExecutableSha256 = [BitConverter]::ToString($sha256.ComputeHash($expectedBytes)).Replace('-', '').ToLowerInvariant()
      $offset = [Text.Encoding]::ASCII.GetString($expectedBytes).IndexOf($compilerMarker, [StringComparison]::Ordinal)
      if ($offset -lt 0 -or $compilerMarker.Length -ne $nsisMarker.Length) {
        throw 'Expected Tauri compiler bundle marker is missing or invalid'
      }
      [Array]::Copy($nsisMarker, 0, $expectedBytes, $offset, $nsisMarker.Length)
      $receipt.expectedPackagedExecutableSha256 = [BitConverter]::ToString($sha256.ComputeHash($expectedBytes)).Replace('-', '').ToLowerInvariant()
    } finally {
      $sha256.Dispose()
    }
  } else {
    $receipt.expectedPackagedExecutableSha256 = $ExpectedPackagedSha256
  }
  if ($receipt.expectedPackagedExecutableSha256 -cne $installedHash) {
    throw 'Installed producer.exe differs from the expected NSIS-patched executable'
  }
  $receipt.installedBinaryMatches = $true
  $receipt.stage = 'report_preflight'
  $reportPaths = @($profiles | ForEach-Object { Join-Path $_ 'live\engine-report.json' })
  if (-not $Headless) {
    foreach ($reportPath in $reportPaths) {
      if (Test-Path -LiteralPath $reportPath) {
        throw 'An engine report already exists before launch'
      }
    }
  }
  $receipt.stage = 'launch'
  $stdoutPath = Join-Path $OutputDir 'app.stdout.log'
  $stderrPath = Join-Path $OutputDir 'app.stderr.log'
  # Let the installed app resolve its own engine modules and data. Restore the
  # caller's build/test override as soon as the child inherits its environment.
  $engineDirOverride = $env:PRODUCER_ENGINE_DIR
  $selftestOverride = $env:PRODUCER_LIVE_SELFTEST
  try {
    $env:PRODUCER_ENGINE_DIR = $null
    $env:PRODUCER_LIVE_SELFTEST = $null
    if ($Headless) { $env:PRODUCER_LIVE_SELFTEST = '1' }
    $app = Start-Process -FilePath $exe -WorkingDirectory $installDir -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    $receipt.engineDirectoryOverrideCleared = $true
  } finally {
    $env:PRODUCER_ENGINE_DIR = $engineDirOverride
    $env:PRODUCER_LIVE_SELFTEST = $selftestOverride
  }
  $receipt.stage = 'engine_report'
  if ($Headless) {
    Wait-OwnedProcess $app 90 'Installed engine self-test'
    $receipt.selftestExitCode = $app.ExitCode
    $stdout = Get-Content -LiteralPath $stdoutPath -Raw -Encoding UTF8
    # selftest_main prints one pretty EngineReport after the native logs. A
    # complete JSON object with column-zero braces is required.
    $reports = [regex]::Matches($stdout, '(?ms)^\{\r?\n.*?^\}\r?$')
    if ($reports.Count -ne 1) { throw 'Installed self-test did not produce one complete EngineReport' }
    $reportJson = $reports[0].Value
    $report = $reportJson | ConvertFrom-Json
  } else {
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    $report = $null
    while ([DateTime]::UtcNow -lt $deadline) {
      foreach ($reportPath in $reportPaths) {
        if (-not (Test-Path -LiteralPath $reportPath)) { continue }
        # A polling read can catch the write in progress. Retry until the
        # report parses and retain the complete JSON we actually validated.
        try {
          $reportJson = Get-Content -LiteralPath $reportPath -Raw -Encoding UTF8
          $report = $reportJson | ConvertFrom-Json
        } catch {
          $report = $null
        }
        if ($report) { break }
      }
      if ($report) { break }
      if ($app.HasExited) { throw "Installed app exited before engine report ($($app.ExitCode))" }
      Start-Sleep -Milliseconds 250
    }
    if (-not $report) { throw 'Installed app produced no complete engine report within 90s' }
  }
  foreach ($field in @('ok','graphics_backend','hardware_encoder','failed_modules','missing_ids','sources')) {
    if ($report.PSObject.Properties.Name -notcontains $field) { throw "EngineReport is missing $field" }
  }
  Set-Content -LiteralPath (Join-Path $OutputDir 'engine-report.json') -Value $reportJson -Encoding UTF8
  $receipt.engineReport = $true
  $receipt.graphicsBackend = $report.graphics_backend
  $receipt.hardwareEncoder = $report.hardware_encoder
  $receipt.stage = 'engine_qualification'
  if ($report.ok -ne $true -or $report.graphics_backend -ne 'd3d11' -or @($report.failed_modules).Count -ne 0 -or @($report.missing_ids).Count -ne 0 -or -not ($report.sources -contains 'browser_source')) {
    $receipt.qualification = 'bootstrap_not_qualified'
    throw 'Installed engine did not qualify: require successful D3D11, all modules/IDs and browser_source; see engine-report.json'
  }
  if (-not $Headless) {
    $receipt.stage = 'post_report_liveness'
    $aliveUntil = [DateTime]::UtcNow.AddSeconds(3)
    while ([DateTime]::UtcNow -lt $aliveUntil) {
      if ($app.HasExited) { throw "Installed app exited after engine report ($($app.ExitCode))" }
      Start-Sleep -Milliseconds 250
    }
    if ($app.HasExited) { throw 'Installed app did not survive post-bootstrap initialization' }
    $receipt.postReportLivenessMs = 3000
  }
  $receipt.status = 'passed'
} finally {
  if ($app -and -not $app.HasExited) { & taskkill.exe /PID $app.Id /T /F 2>$null | Out-Null }
  try {
    $uninstaller = Join-Path $installDir 'uninstall.exe'
    if ($installed -and (Test-Path -LiteralPath $uninstaller)) {
      $uninstall = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru
      Wait-OwnedProcess $uninstall 90 'NSIS cleanup'
    }
  } catch {
    $receipt.status = 'failed'
    $receipt.stage = 'cleanup'
    $receipt.cleanup = 'failed'
    throw
  } finally {
    if ($receipt.status -eq 'passed') { $receipt.stage = 'complete' }
    $receipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutputDir 'installed-proof.json') -Encoding UTF8
  }
}
