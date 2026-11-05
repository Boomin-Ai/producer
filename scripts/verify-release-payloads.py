#!/usr/bin/env python3
"""Release promotion gate: exact complete payloads, pinned updater signatures and hashes."""
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tomllib

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

release_id = os.environ['PRODUCER_RELEASE_ID']
assert release_id.isdecimal(), 'Expected one reserved release ID'
release = json.loads(gh('api', f'repos/{repo}/releases/{release_id}'))
assert release['draft'] and not release['prerelease'], 'Release must remain a stable draft until verification completes'
assert release['target_commitish'] == sha and release['tag_name'] == tag, 'Release does not match the build source and version'
assets = {a['name']: a for a in release['assets'] if a['state'] == 'uploaded'}

# Build one manifest from the completed platform artifacts. Parallel jobs
# never create drafts or write latest.json. Keep the existing updater aliases.
arm = f'Producer_{version}_aarch64.app.tar.gz'
intel = 'Producer_x64.app.tar.gz'
nsis = f'Producer_{version}_x64-setup.exe'
appimage = f'Producer_{version}_amd64.AppImage'
platforms = {
    'darwin-aarch64': arm, 'darwin-aarch64-app': arm,
    'darwin-x86_64': intel, 'darwin-x86_64-app': intel,
    'windows-x86_64': nsis, 'windows-x86_64-nsis': nsis,
    'linux-x86_64': appimage, 'linux-x86_64-appimage': appimage,
}
for platform, name in {
    'windows-x86_64-msi': f'Producer_{version}_x64_en-US.msi',
    'linux-x86_64-deb': f'Producer_{version}_amd64.deb',
    'linux-x86_64-rpm': f'Producer-{version}-1.x86_64.rpm',
}.items():
    if name in assets:
        platforms[platform] = name
manifest = {
    'version': version,
    'notes': f'Producer {tag}',
    'pub_date': datetime.now(timezone.utc).isoformat(timespec='seconds'),
    'platforms': {},
}
pubkey = base64.b64decode(config['plugins']['updater']['pubkey']).decode().splitlines()[1]
checks = []
verified = {}

def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def checked_asset(name):
    assert name in assets, f'Missing release asset {name}'
    path = download(name)
    assert path.stat().st_size == assets[name]['size'], f'Size mismatch for {name}'
    sha256 = digest(path)
    if assets[name].get('digest'):
        assert assets[name]['digest'] == 'sha256:' + sha256, f'Digest mismatch for {name}'
    return path, sha256

for platform, name in platforms.items():
    if name not in verified:
        payload, sha256 = checked_asset(name)
        signature_asset, _ = checked_asset(name + '.sig')
        encoded = signature_asset.read_text().strip()
        signature = out / (name + '.verification.sig')
        signature.write_bytes(base64.b64decode(encoded, validate=True))
        subprocess.run(['minisign', '-Vm', str(payload), '-x', str(signature), '-P', pubkey], check=True)
        verified[name] = (encoded, sha256)
    encoded, sha256 = verified[name]
    manifest['platforms'][platform] = {'signature': encoded, 'url': f'https://github.com/{repo}/releases/download/{tag}/{name}'}
    checks.append({'platform': platform, 'asset': name, 'sha256': sha256, 'signatureVerified': True})
for name in [f'Producer_{version}_aarch64.dmg', f'Producer_{version}_x64.dmg']:
    _, sha256 = checked_asset(name)
    checks.append({'asset': name, 'sha256': sha256})
receipt = {'version': version, 'sha': sha, 'releaseId': int(release_id), 'checks': checks}
(out / 'latest.json').write_text(json.dumps(manifest, indent=2) + '\n')
(out / 'verification.json').write_text(json.dumps(receipt, indent=2) + '\n')
notes_path = Path('docs') / f'RELEASE-{version}.md'
assert notes_path.is_file(), f'Missing release notes: {notes_path}'
(out / 'release-notes.md').write_text(notes_path.read_text() + "\n\nUpdater payloads passed signature verification against Producer’s pinned public key before publication. macOS installers passed signing, notarization and stapling. See verification.json for exact artifact hashes.\n")
subprocess.run(['gh', 'release', 'upload', tag, str(out / 'latest.json'), str(out / 'verification.json'), '--clobber', '--repo', repo], check=True)
print(json.dumps(receipt, indent=2))
