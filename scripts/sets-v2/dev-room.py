#!/usr/bin/env python3
"""Build/stage an isolated v2 app using the installed read-only engine runtime."""
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import urllib.request

root = Path(__file__).resolve().parents[2]
runtime = Path(os.environ.get('PRODUCER_PROBE_APP', '/Applications/Producer.app'))
target = Path(os.environ.get('PRODUCER_SETS_V2_APP_TARGET', '/private/tmp/producer-sets-v2-app-check'))
stage = root / 'src-tauri/target/sets-v2-dev/Producer Sets v2 Dev.app'
config = json.loads((root / 'src-tauri/tauri.sets-v2-dev.conf.json').read_text())
if config['identifier'] != 'ai.boomin.producer.sets-v2-dev':
    raise SystemExit('Refusing to build the v2 development app without its isolated identity')
if not (runtime / 'Contents/Frameworks/libobs.framework').is_dir():
    raise SystemExit('Installed Producer runtime not found')
if subprocess.run(['pgrep', '-f', str(stage / 'Contents/MacOS/producer')], stdout=subprocess.DEVNULL).returncode == 0:
    raise SystemExit('Close only Producer Sets v2 Dev before replacing its bundle')
with urllib.request.urlopen('http://127.0.0.1:1436/', timeout=3) as response:
    if response.status != 200:
        raise SystemExit('Start npm run dev:sets-v2 on port 1436 first')
env = dict(os.environ, CARGO_TARGET_DIR=str(target), CARGO_PROFILE_DEV_DEBUG='0', CARGO_INCREMENTAL='0', CARGO_BUILD_JOBS='1', PRODUCER_ENGINE_DIR=str(runtime / 'Contents'), TAURI_CONFIG=json.dumps(config))
# Fresh catalog: never seed retired sets back into the development library.
# Grand Arena's configured copy is preserved; new showcase packages will be
# added explicitly after their capability and output acceptance checks pass.
profile=Path.home()/'Library/Application Support'/config['identifier']
library=profile/'sets-library'
library.mkdir(parents=True,exist_ok=True)
original=root/'docs/shows/head-to-head-grand-arena.json'
destination=library/original.name
if not destination.exists():
    shutil.copyfile(original,destination)
for name in ['decision-room','open-floor','atmosphere','just-facts']:
    original=root/'docs/shows'/(name+'.json')
    destination=library/original.name
    if not destination.exists():shutil.copyfile(original,destination)
original_grants=Path.home()/'Library/Application Support/ai.boomin.producer/set-media-files.json'
if original_grants.is_file() and not (profile/'set-media-files.json').exists():
    shutil.copyfile(original_grants,profile/'set-media-files.json')
# This isolated desktop app needs the Rust library and binary only. Avoid
# emitting redundant static/mobile library archives on a storage-limited host.
manifest=root/'src-tauri/Cargo.toml'
original_manifest=manifest.read_text()
try:
    manifest.write_text(original_manifest.replace('crate-type = ["staticlib", "cdylib", "rlib"]','crate-type = ["rlib"]'))
    subprocess.run(['cargo', 'build', '--offline', '--manifest-path', str(manifest), '--features', 'sets-v2-dev'], cwd=root, env=env, check=True)
finally:
    manifest.write_text(original_manifest)
stage.parent.mkdir(parents=True, exist_ok=True)
if stage.exists():
    shutil.rmtree(stage)
# APFS clone, never a symlink/hardlink to the production bundle. Helper launch
# needs actual bundle topology; changing these files cannot modify the original.
subprocess.run(['cp', '-cR', str(runtime), str(stage)], check=True)
shutil.copyfile(target / 'debug/producer', stage / 'Contents/MacOS/producer')
plist = stage / 'Contents/Info.plist'
with plist.open('rb') as stream:
    info = plistlib.load(stream)
info.update(CFBundleIdentifier=config['identifier'], CFBundleDisplayName='Producer Sets v2 Dev', CFBundleName='producer', CFBundleExecutable='producer')
with plist.open('wb') as stream:
    plistlib.dump(info, stream)
subprocess.run(['codesign', '--force', '--sign', '-', str(stage)], check=True)
subprocess.run(['codesign', '--verify', '--deep', '--strict', str(stage)], check=True)
print(f'Prepared isolated app: {stage}', flush=True)
if '--prepare' not in sys.argv:
    args = ['open', '-n', '--env', f'PRODUCER_DEV_MODULE_CONFIG_DIR={stage.parent / "module-config"}']
    if '--smoke' in sys.argv:
        args += ['--env', 'PRODUCER_SETS_V2_UI_PROBE=1']
    subprocess.run(args + [str(stage)], check=True)
