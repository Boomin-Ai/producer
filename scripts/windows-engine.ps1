# windows-engine.ps1 -- shared by dev-windows.ps1 and build-windows.ps1.
#
# Resolves the Windows engine artifact for the CURRENT engine/obs.lock (the
# name is hash-addressed: producer-libobs-windows-x64-<sha256(obs.lock)[0:12]>),
# downloads it from the newest green engine.yml run that carries it when it is
# not on disk, proves it with engine-closure-windows.sh, and stages the flat
# layout the shipped app needs (obs.dll beside producer.exe, obs-plugins/ and
# data/ as siblings) under src-tauri/windows-bundle/, which
# src-tauri/tauri.windows.conf.json bundles into the installer root.
#
# Dot-source it:  . "$PSScriptRoot\windows-engine.ps1"
$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

function Get-LockHash {
  (Get-FileHash -Algorithm SHA256 (Join-Path $RepoRoot "engine\obs.lock")).Hash.ToLower().Substring(0, 12)
}

function Get-EngineName { "producer-libobs-windows-x64-$(Get-LockHash)" }

function Get-EngineDir {
  $name = Get-EngineName
  $dir = Join-Path $RepoRoot "engine\artifacts\$name"
  if (Test-Path (Join-Path $dir "bin\obs.dll")) { return $dir }

  Write-Host "engine $name not on disk; fetching from the newest green engine.yml run that carries it"
  $runs = gh run list --workflow=engine.yml --status success --limit 10 --json databaseId -q '.[].databaseId'
  if (-not $runs) { throw "no green engine.yml runs found (gh auth?)" }
  $tmp = Join-Path $env:TEMP "producer-engine-dl"
  foreach ($run in $runs) {
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    New-Item -ItemType Directory -Force $tmp | Out-Null
    gh run download $run -n producer-libobs-windows-x64 -D $tmp 2>$null
    if ($LASTEXITCODE -ne 0) { continue }
    $zst = Get-ChildItem $tmp -Filter "$name.tar.zst" -Recurse | Select-Object -First 1
    if ($zst) { Write-Host "found in run $run"; break }
    $zst = $null
  }
  if (-not $zst) {
    throw "no engine artifact matches the current obs.lock ($name) in the last 10 green engine runs. Run engine.yml for this lock first."
  }
  # sha256 sidecar
  $want = (Get-Content "$($zst.FullName).sha256").Split(" ")[0].ToLower()
  $have = (Get-FileHash -Algorithm SHA256 $zst.FullName).Hash.ToLower()
  if ($want -ne $have) { throw "engine artifact checksum mismatch" }

  New-Item -ItemType Directory -Force $dir | Out-Null
  # .tar.zst: Windows tar has no zstd; python + zstandard does (pip install zstandard).
  python -c "import zstandard" 2>$null
  if ($LASTEXITCODE -ne 0) { python -m pip install -q zstandard }
  $py = @"
import sys, zstandard, tarfile, os, shutil, warnings
warnings.simplefilter('ignore')
z, dest = sys.argv[1], sys.argv[2]
with open(z, 'rb') as f, zstandard.ZstdDecompressor().stream_reader(f) as r:
    tarfile.open(fileobj=r, mode='r|').extractall(dest)
inner = [d for d in os.listdir(dest) if d.startswith('producer-libobs-windows-x64-')]
if inner:
    for n in os.listdir(os.path.join(dest, inner[0])):
        shutil.move(os.path.join(dest, inner[0], n), os.path.join(dest, n))
    os.rmdir(os.path.join(dest, inner[0]))
"@
  python -c $py $zst.FullName $dir
  if ($LASTEXITCODE -ne 0) { throw "engine extract failed" }
  Remove-Item -Recurse -Force $tmp
  if (-not (Test-Path (Join-Path $dir "bin\obs.dll"))) { throw "engine extracted but bin\obs.dll is missing" }
  return $dir
}

function Test-EngineGate([string]$dir) {
  # The closure gate is bash (Git for Windows ships it); it proves the artifact
  # is self-contained and carries every Producer-owned replacement.
  $bash = "C:\Program Files\Git\bin\bash.exe"
  if (-not (Test-Path $bash)) { $bash = "bash" }
  $posix = ($dir -replace '\\', '/') -replace '^([A-Za-z]):', '/$1'
  & $bash "$($RepoRoot -replace '\\','/')/scripts/engine-closure-windows.sh" $posix
  if ($LASTEXITCODE -ne 0) { throw "engine closure gate FAILED for $dir" }
}

function Sync-WindowsBundle([string]$dir) {
  # Flat layout: producer.exe imports obs.dll statically, so the loader must
  # find it in the exe's own directory -- bin/ is flattened to the root.
  # inside src-tauri: a resource glob with "../" in it flattens every file into the install root
  $stage = Join-Path $RepoRoot "src-tauri\windows-bundle"
  New-Item -ItemType Directory -Force $stage | Out-Null
  $null = robocopy (Join-Path $dir "bin") $stage /MIR /NFL /NDL /NJH /NJS /XD obs-plugins data licenses
  if ($LASTEXITCODE -ge 8) { throw "robocopy bin failed ($LASTEXITCODE)" }
  foreach ($sub in "obs-plugins", "data", "licenses") {
    $null = robocopy (Join-Path $dir $sub) (Join-Path $stage $sub) /MIR /NFL /NDL /NJH /NJS
    if ($LASTEXITCODE -ge 8) { throw "robocopy $sub failed ($LASTEXITCODE)" }
  }
  Copy-Item (Join-Path $dir "manifest.json") (Join-Path $stage "manifest.json") -Force
  $n = (Get-ChildItem $stage -Recurse -File | Measure-Object).Count
  Write-Host "windows-bundle staged: $n files from $(Split-Path $dir -Leaf)"
  return $stage
}
