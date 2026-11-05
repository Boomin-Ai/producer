#!/usr/bin/env python3
"""Release promotion gate: exact complete payloads, pinned updater signatures and hashes."""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tomllib
from urllib.parse import unquote, urlparse

repo = os.environ['GITHUB_REPOSITORY']
sha = os.environ['GITHUB_SHA']
config = json.loads(Path('src-tauri/tauri.conf.json').read_text())
version = config['version']
assert '-' not in version, 'Public promotion requires a stable version'
assert json.loads(Path('package.json').read_text())['version'] == version
assert tomllib.loads(Path('src-tauri/Cargo.toml').read_text())['package']['version'] == version
lock = tomllib.loads(Path('src-tauri/Cargo.lock').read_text())
assert next(p['version'] for p in lock['package'] if p['name'] == 'producer') == version
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
platforms = ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64', 'windows-x86_64-nsis', 'linux-x86_64']
if 'windows-x86_64-msi' in manifest['platforms']:
    platforms.append('windows-x86_64-msi')
assert manifest['platforms']['windows-x86_64'] == manifest['platforms']['windows-x86_64-nsis']
for platform in platforms:
    item = manifest['platforms'][platform]
    url = urlparse(item['url'])
    prefix = f'/{repo}/releases/download/{tag}/'
    assert url.scheme == 'https' and url.netloc == 'github.com' and url.path.startswith(prefix)
    name = unquote(url.path[len(prefix):])
    assert name and '/' not in name and name in assets
    # tauri-action's established Intel mac updater archive has no version in
    # its filename. Its exact release URL, draft source SHA and pinned-key
    # signature remain required above/below. Windows installers are versioned.
    if platform == 'darwin-x86_64':
        assert name == 'Producer_x64.app.tar.gz'
    else:
        assert name.startswith(f'Producer_{version}_'), 'Payload filename must match this release version'
    if platform in ('windows-x86_64', 'windows-x86_64-nsis'):
        assert name == f'Producer_{version}_x64-setup.exe'
    if platform == 'windows-x86_64-msi':
        assert name == f'Producer_{version}_x64_en-US.msi'
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
notes_path = Path('docs') / f'RELEASE-{version}.md'
assert notes_path.is_file(), f'Missing release notes: {notes_path}'
(out / 'release-notes.md').write_text(notes_path.read_text() + "\n\nAll four primary updater payloads passed signature verification against Producer’s pinned public key before publication. macOS installers passed the platform signing, notarization and stapling jobs. See verification.json for exact artifact hashes.\n")
print(json.dumps(receipt, indent=2))
