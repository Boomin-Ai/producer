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
# Read existing set files into a separate editable library. Original packages and
# media grants remain untouched; no account credentials/workspace DB are copied.
profile=Path.home()/'Library/Application Support'/config['identifier']
library=profile/'sets-library'
library.mkdir(parents=True,exist_ok=True)
for original in (Path.home()/'Documents/boomin/docs/shows').glob('*.json'):
    destination=library/original.name
    if not destination.exists():
        shutil.copyfile(original,destination)
original_grants=Path.home()/'Library/Application Support/ai.boomin.producer/set-media-files.json'
if original_grants.is_file() and not (profile/'set-media-files.json').exists():
    shutil.copyfile(original_grants,profile/'set-media-files.json')
subprocess.run(['cargo', 'build', '--offline', '--manifest-path', str(root / 'src-tauri/Cargo.toml'), '--features', 'sets-v2-dev'], cwd=root, env=env, check=True)
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
