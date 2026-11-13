$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\windows-dev-helpers.ps1"
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$fixture = Join-Path $tempRoot ('producer-dev-helpers-test-' + [guid]::NewGuid().ToString('N'))
try {
  $engine = Join-Path $fixture 'engine with spaces'
  $bin = Join-Path $engine 'bin'
  $output = Join-Path $fixture 'custom cargo target\debug\build\producer\receipt-hash\out'
  New-Item -ItemType Directory -Force -Path $bin, $output | Out-Null
  $names = @('obs-ffmpeg-mux.exe','obs-nvenc-test.exe','obs-qsv-test.exe','obs-amf-test.exe')
  foreach ($name in $names) { Set-Content -LiteralPath (Join-Path $bin $name) -Value "copy-only fixture $name" }
  Set-Content -LiteralPath (Join-Path $output 'producer.exe') -Value 'preserve main executable'
  $copied = @(Sync-WindowsDevHelpers -EngineDir $engine -OutputDir $output)
  if ($copied.Count -ne 4) { throw 'Required helper count mismatch' }
  foreach ($name in $names) {
    if ((Get-FileHash -LiteralPath (Join-Path $bin $name)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $output $name)).Hash) {
      throw "Helper copy mismatch: $name"
    }
  }
  if ((Get-Content -LiteralPath (Join-Path $output 'producer.exe') -Raw).Trim() -ne 'preserve main executable') { throw 'Main executable was changed' }
  Remove-Item -LiteralPath (Join-Path $bin 'obs-ffmpeg-mux.exe')
  $rejected = $false
  try { Sync-WindowsDevHelpers -EngineDir $engine -OutputDir (Join-Path $fixture 'missing-helper-output') | Out-Null }
  catch { if ($_.Exception.Message -notmatch 'obs-ffmpeg-mux.exe') { throw }; $rejected = $true }
  if (-not $rejected) { throw 'Missing recording helper was silently accepted' }
  if (Test-Path -LiteralPath (Join-Path $fixture 'missing-helper-output')) { throw 'Staging began before validating required helpers' }
  'PASS: Windows dev stages muxer and encoder helpers beside custom-target executable, preserves existing files, and rejects a missing muxer before staging.'
} finally {
  $resolvedFixture = [IO.Path]::GetFullPath($fixture)
  if (-not $resolvedFixture.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $resolvedFixture -Leaf) -notlike 'producer-dev-helpers-test-*') { throw 'Unsafe fixture cleanup path' }
  if (Test-Path -LiteralPath $resolvedFixture) { Remove-Item -LiteralPath $resolvedFixture -Recurse -Force }
}
