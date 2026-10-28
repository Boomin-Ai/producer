#!/usr/bin/env python3
"""Release promotion gate: exact complete payloads, pinned updater signatures and hashes."""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
from urllib.parse import unquote, urlparse

repo = os.environ['GITHUB_REPOSITORY']
sha = os.environ['GITHUB_SHA']
config = json.loads(Path('src-tauri/tauri.conf.json').read_text())
version = config['version']
tag = 'v' + version
out = Path('/tmp/producer-release-verification')
out.mkdir(parents=True, exist_ok=True)

def gh(*args):
    return subprocess.check_output(['gh', *args], text=True)

def download(name):
    target = out / name
    if not target.exists():
        subprocess.run(['gh', 'release', 'download', tag, '--repo', repo, '--pattern', name, '--dir', str(out)], check=True)
    return target

release = json.loads(gh('release', 'view', tag, '--repo', repo, '--json', 'isDraft,targetCommitish,assets'))
assert release['isDraft'], 'Release must remain a draft until verification completes'
assert release['targetCommitish'] == sha, 'Release does not match the build commit'
assets = {a['name']: a for a in release['assets']}
manifest = json.loads(download('latest.json').read_text())
assert manifest['version'] == version
pubkey = base64.b64decode(config['plugins']['updater']['pubkey']).decode().splitlines()[1]
checks = []
for platform in ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64', 'linux-x86_64']:
    item = manifest['platforms'][platform]
    url = urlparse(item['url'])
    prefix = f'/{repo}/releases/download/{tag}/'
    assert url.scheme == 'https' and url.netloc == 'github.com' and url.path.startswith(prefix)
    name = unquote(url.path[len(prefix):])
    assert name and '/' not in name and name in assets
    payload = download(name)
    assert payload.stat().st_size == assets[name]['size']
    signature = out / (name + '.verification.sig')
    signature.write_bytes(base64.b64decode(item['signature'], validate=True))
    subprocess.run(['minisign', '-Vm', str(payload), '-x', str(signature), '-P', pubkey], check=True)
    checks.append({'platform': platform, 'asset': name, 'sha256': hashlib.file_digest(payload.open('rb'), 'sha256').hexdigest(), 'signatureVerified': True})
for name in [f'Producer_{version}_aarch64.dmg', f'Producer_{version}_x64.dmg']:
    assert name in assets
    payload = download(name)
    assert payload.stat().st_size == assets[name]['size']
    checks.append({'asset': name, 'sha256': hashlib.file_digest(payload.open('rb'), 'sha256').hexdigest()})
receipt = {'version': version, 'sha': sha, 'checks': checks}
(out / 'verification.json').write_text(json.dumps(receipt, indent=2) + '\n')
subprocess.run(['gh', 'release', 'upload', tag, str(out / 'verification.json'), '--clobber', '--repo', repo], check=True)
(out / 'release-notes.md').write_text(f'''Producer {version} introduces Atmosphere, a standalone weather observatory with larger host video, three camera compositions in portrait and landscape, and Now / Today / Hourly / 7 day forecasts.

Choose a city directly in the room's Weather desk controls. Each Set instance owns its city selection; saved Integration defaults and credentials stay in Integrations. Forecast delivery is bounded and late replies cannot put a previous city's numbers under a newly selected city.

Generated day/night architecture, restrained GPU 3D lighting and weather effects compose behind native camera video and crisp text. Camera compositions use coordinated native transitions. No Show is required. Open-Meteo supplies model forecasts; Map, radar, air quality and severe-weather alerts are not included.

The hosted module authority and audience runtime support the same forecast contract, bounded city caching, explicit refresh and honest stale-data labels. Hourly forecasts include animated temperature and precipitation charts. Shared renderer updates add bounded mask/backdrop/chart capabilities, retained graphics surfaces and preview placement fixes. Atmosphere is the only bundled built-in Set. Other authored presentation/2 packages, including Attention Is Currency, can be imported without adding them to the built-in catalog.

macOS installers are Apple signed, notarized and stapled by the platform release jobs. All four primary updater payloads passed signature verification against Producer's pinned public key before publication. verification.json contains the exact artifact hashes.

Requires presentation/2 packages. API keys are never bundled. The 3D/native compositor capability is macOS Apple Silicon only. Windows retains its existing Live engine; Intel macOS and Linux retain their engine-less scope. Cameras, mixer and output remain room-owned.
''')
print(json.dumps(receipt, indent=2))
