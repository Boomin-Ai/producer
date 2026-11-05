# Installed production binary proof. Only run on a disposable hosted Windows
# runner: NSIS changes current-user shortcuts/registry and the firewall rule.
param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][string]$ExpectedExecutable,
  [Parameter(Mandatory=$true)][string]$OutputDir
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'Installed qualification requires a disposable GitHub-hosted runner'
}
$Installer = (Resolve-Path -LiteralPath $Installer).Path
$ExpectedExecutable = (Resolve-Path -LiteralPath $ExpectedExecutable).Path
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
$receipt = [ordered]@{ schema='producer.windows-installed-proof/1'; status='failed'; source=$env:PRODUCER_SOURCE_SHA; engineReport=$false; installedBinaryMatches=$false }
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
  $p = Start-Process -FilePath $Installer -ArgumentList @('/S', "/D=$installDir") -PassThru
  Wait-OwnedProcess $p 120 'NSIS install'
  $installed = $true
  foreach ($must in @('producer.exe','uninstall.exe','obs.dll','obs-plugins\64bit\obs-browser.dll','obs-plugins\64bit\Producer Helper.exe','data\obs-plugins\win-dshow\obs-virtualcam-module64.dll','data\obs-plugins\win-dshow\placeholder.png')) {
    if (-not (Test-Path -LiteralPath (Join-Path $installDir $must))) { throw "Installed engine payload missing $must" }
  }
  $exe = Join-Path $installDir 'producer.exe'
  $expectedHash = (Get-FileHash -LiteralPath $ExpectedExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
  $installedHash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($expectedHash -ne $installedHash) { throw 'Installer contains a different producer.exe from this build' }
  $receipt.installedBinaryMatches = $true
  $receipt.executableSha256 = $installedHash
  $started = [DateTime]::UtcNow
  $app = Start-Process -FilePath $exe -WorkingDirectory $installDir -PassThru -RedirectStandardOutput (Join-Path $OutputDir 'app.stdout.log') -RedirectStandardError (Join-Path $OutputDir 'app.stderr.log')
  $deadline = [DateTime]::UtcNow.AddSeconds(90)
  $reportFile = $null
  $report = $null
  while ([DateTime]::UtcNow -lt $deadline) {
    foreach ($profile in $profiles) {
      $candidate = Join-Path $profile 'engine-report.json'
      if ((Test-Path -LiteralPath $candidate) -and (Get-Item -LiteralPath $candidate).LastWriteTimeUtc -ge $started) {
        # The engine writes once, but a polling read can catch that write in
        # progress. Accept only a complete report, not merely file existence.
        try { $parsed = Get-Content -LiteralPath $candidate -Raw | ConvertFrom-Json } catch { $parsed = $null }
        if ($parsed -and ($parsed.PSObject.Properties.Name -contains 'ok')) { $report = $parsed; $reportFile = $candidate; break }
      }
    }
    if ($reportFile) { break }
    if ($app.HasExited) { throw "Installed app exited before engine report ($($app.ExitCode))" }
    Start-Sleep -Milliseconds 250
  }
  if (-not $reportFile) { throw 'Installed app produced no complete engine report within 90s' }
  Copy-Item -LiteralPath $reportFile -Destination (Join-Path $OutputDir 'engine-report.json')
  $receipt.engineReport = $true
  $receipt.graphicsBackend = $report.graphics_backend
  $receipt.hardwareEncoder = $report.hardware_encoder
  if ($report.ok -ne $true -or $report.graphics_backend -ne 'd3d11' -or @($report.failed_modules).Count -ne 0 -or @($report.missing_ids).Count -ne 0 -or -not ($report.sources -contains 'browser_source')) {
    $receipt.qualification = 'bootstrap_not_qualified'
    throw 'Installed engine did not qualify: require successful D3D11, all modules/IDs and browser_source; see engine-report.json'
  }
  $aliveUntil = [DateTime]::UtcNow.AddSeconds(3)
  while ([DateTime]::UtcNow -lt $aliveUntil) {
    if ($app.HasExited) { throw "Installed app exited after engine report ($($app.ExitCode))" }
    Start-Sleep -Milliseconds 250
  }
  if ($app.HasExited) { throw 'Installed app did not survive post-bootstrap initialization' }
  $receipt.postReportLivenessMs = 3000
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
    $receipt.cleanup = 'failed'
    throw
  } finally {
    $receipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutputDir 'installed-proof.json') -Encoding UTF8
  }
}
