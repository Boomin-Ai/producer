# OBS resolves these subprocesses beside the main executable, not through PATH.
function Sync-WindowsDevHelpers {
  param(
    [Parameter(Mandatory=$true)][string]$EngineDir,
    [Parameter(Mandatory=$true)][string]$OutputDir
  )
  $helpers = @('obs-ffmpeg-mux.exe', 'obs-nvenc-test.exe', 'obs-qsv-test.exe', 'obs-amf-test.exe')
  $bin = Join-Path $EngineDir 'bin'
  foreach ($helper in $helpers) {
    if (-not (Test-Path -LiteralPath (Join-Path $bin $helper) -PathType Leaf)) {
      throw "Pinned Windows engine is missing required runtime helper: $helper"
    }
  }
  New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
  foreach ($helper in $helpers) {
    Copy-Item -LiteralPath (Join-Path $bin $helper) -Destination (Join-Path $OutputDir $helper) -Force
  }
  return $helpers
}
