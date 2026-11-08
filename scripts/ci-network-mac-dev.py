#!/usr/bin/env python3
"""Unreleased CI artifact gates. Native acceptance is limited to the IPC smoke."""
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import subprocess
import sys

SOURCE_DEFAULT = '98a2a87fadced029f6adf0ae3df223e63c0992d3'
ENGINE_PIN = 'f8b2551c9526a0cda2d1a333dcafeff343476589119f19888dfd0cd44030ec8e'
IDENTIFIER = 'ai.boomin.producer.sets-v2-dev'
DEV_ORIGIN = 'http://localhost:1436'
FEATURES = ['sets-v2-dev', 'guest-rtc-production']
DEV_ENTITLEMENTS = {
    'com.apple.security.device.audio-input': True,
    'com.apple.security.device.camera': True,
    'com.apple.security.cs.allow-unsigned-executable-memory': True,
    'com.apple.security.cs.disable-library-validation': True,
}
FORBIDDEN_ENTITLEMENTS = ['com.apple.application-identifier', 'application-identifier',
                         'com.apple.developer.system-extension.install', 'com.apple.security.application-groups']


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def git(source, *args):
    return subprocess.check_output(['git', '-C', str(source), *args])


def check_source(source):
    actual = git(source, 'rev-parse', 'HEAD').decode().strip()
    expected = os.environ.get('CANDIDATE_SOURCE_SHA', '')
    require(re.fullmatch('[0-9a-f]{40}', expected) and actual == expected, 'Application source does not match the explicit full SHA')
    require(os.environ.get('PINNED_ENGINE_LOCK_SHA256') == ENGINE_PIN, 'Workflow/tooling engine pins disagree')
    require(digest(source / 'engine/obs.lock') == ENGINE_PIN, 'Application changed the pinned engine lock')
    package = json.loads((source / 'package.json').read_text())
    config = json.loads((source / 'src-tauri/tauri.conf.json').read_text())
    cargo = (source / 'src-tauri/Cargo.toml').read_text().split('[package]', 1)[1].split('\n[', 1)[0]
    require(config['version'] == package['version'] and re.search(r'^version\s*=\s*"' + re.escape(config['version']) + r'"\s*$', cargo, re.M), 'Frontend/native versions disagree')
    require(not git(source, 'status', '--porcelain', '--untracked-files=no').strip(), 'Application checkout has tracked modifications')
    return actual, config['version']


def isolated_config(dev, source):
    require(dev.get('identifier') == IDENTIFIER and dev.get('build', {}).get('devUrl') == DEV_ORIGIN, 'Source does not contain the expected isolated development identity/bootstrap')
    require(dev['build'].get('frontendDist') in [None, DEV_ORIGIN], 'Unexpected frontend override in the development overlay')
    require('capabilities' not in dev.get('app', {}).get('security', {}), 'Keep the source default capabilities; no inline remote grants are accepted')
    result = json.loads(json.dumps(dev))
    result['productName'] = 'Producer DJ Test'
    # Tauri release builds derive the local app origin from frontendDist, not
    # devUrl. Native sets-v2-dev then navigates to this exact loopback origin.
    # A filesystem frontendDist would make that navigation remote and deny
    # BOTH core/plugin IPC and custom app commands. Keep this CI-only override
    # behind the exact isolated-ID/bootstrap gates; production stays bundled.
    result['build']['frontendDist'] = DEV_ORIGIN
    for window in result.get('app', {}).get('windows', []):
        require(window.get('label', 'main') == 'main' and window.get('url', 'index.html') in ['index.html', './index.html'], 'Unexpected window or remote navigation in development overlay')
        window['title'] = 'Producer DJ Test'
    result['bundle'] = {'targets': ['app'], 'createUpdaterArtifacts': False}
    # This unreleased dev app must not replace itself from the production updater.
    result['plugins'] = {'updater': {'endpoints': []}}
    return result


def prepare(source, destination):
    sha, version = check_source(source)
    config = isolated_config(json.loads((source / 'src-tauri/tauri.sets-v2-dev.conf.json').read_text()), source)
    destination.mkdir(parents=True, exist_ok=True)
    (destination / 'candidate.json').write_text(json.dumps(config, indent=2) + '\n')
    (destination / 'dev-entitlements.plist').write_bytes(plistlib.dumps(DEV_ENTITLEMENTS))
    print('Validated isolated source ' + sha + ' version ' + version + '; pinned engine and port 1436.')


def check_manifest(stage, expected_lock):
    manifest = json.loads((stage / 'manifest.json').read_text())
    require(manifest.get('lock') == expected_lock, 'Engine manifest does not match the pinned source lock')
    files = manifest.get('files')
    require(isinstance(files, dict) and 0 < len(files) <= 100000, 'Engine file manifest is invalid')
    for name, sha in files.items():
        relative = PurePosixPath(name)
        require(not relative.is_absolute() and '..' not in relative.parts and '\\' not in name, 'Invalid engine manifest path')
        path = stage / name
        require(path.resolve().is_relative_to(stage.resolve()), 'Engine manifest path leaves its artifact')
        require(re.fullmatch('[0-9a-f]{64}', str(sha)) and path.is_file() and digest(path) == sha, 'Engine artifact file verification failed: ' + name)
    for name in ['Frameworks/libobs.framework/Versions/A/libobs', 'Frameworks/libobs-metal.dylib',
                 'PlugIns/obs-browser.plugin/Contents/MacOS/obs-browser',
                 'PlugIns/mac-virtualcam.plugin/Contents/MacOS/mac-virtualcam']:
        require(name in files and (stage / name).is_file(), 'Required engine/native guest/virtual-camera runtime binary is missing')
    return manifest


def verify_engine(source, stage):
    check_source(source)
    manifest = check_manifest(stage, json.loads((source / 'engine/obs.lock').read_text()))
    print('Verified pinned engine manifest and ' + str(len(manifest['files'])) + ' file hashes.')


def receipt(source, app, output, tools):
    sha, version = check_source(source)
    infrastructure = git(tools.parent, 'rev-parse', 'HEAD').decode().strip()
    require(infrastructure == os.environ.get('INFRASTRUCTURE_SHA'), 'Build tooling source changed')
    info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
    require(info.get('CFBundleIdentifier') == IDENTIFIER and info.get('CFBundleShortVersionString') == version, 'Built identity/version mismatch')
    binary = app / 'Contents/MacOS' / info['CFBundleExecutable']
    arches = subprocess.check_output(['lipo', '-archs', str(binary)], text=True).split()
    require(arches == ['arm64'], 'Mac candidate must contain only arm64')
    signature = subprocess.run(['codesign', '-dv', '--verbose=4', str(app)], capture_output=True, text=True, check=True).stderr
    team = re.search(r'^TeamIdentifier=(.+)$', signature, re.M)
    require(team and team.group(1) == os.environ['NOTARY_TEAM'], 'Unexpected Developer ID signing team')
    signed = plistlib.loads(subprocess.check_output(['codesign', '-d', '--entitlements', ':-', str(app)], stderr=subprocess.DEVNULL))
    require(all(signed.get(k) is True for k in DEV_ENTITLEMENTS), 'Dev capture/CEF hardened runtime entitlements are missing')
    require(all(k not in signed for k in FORBIDDEN_ENTITLEMENTS), 'Dev app incorrectly claims production/profile-backed entitlements')
    uuids = lambda path: sorted(set(re.findall(r'UUID: ([A-Fa-f0-9-]+)', path.read_text())))
    binary_uuids, symbol_uuids = uuids(output / 'symbols/binary-uuid.txt'), uuids(output / 'symbols/symbol-uuid.txt')
    require(binary_uuids and binary_uuids == symbol_uuids, 'Native symbol UUID does not match the app binary')
    notarized = os.environ.get('NOTARIZE', '1') == '1'
    submission = os.environ.get('NOTARY_SUBMISSION_ID', '')
    require(not notarized or re.fullmatch('[A-Fa-f0-9-]{36}', submission), 'Missing accepted notarization receipt')
    archive = output / 'Producer-DJ-Test-mac-arm64.zip'
    generated_config = Path(os.environ['RUNNER_TEMP']) / 'network-mac-dev-config/candidate.json'
    expected_config = isolated_config(json.loads((source / 'src-tauri/tauri.sets-v2-dev.conf.json').read_text()), source)
    require(json.loads(generated_config.read_text()) == expected_config, 'Generated dev runtime configuration changed')
    (output / 'dev-config.json').write_bytes(generated_config.read_bytes())
    smoke_path = output / 'native-origin-smoke.json'
    smoke = json.loads(smoke_path.read_text())
    require(smoke.get('schema') == 'producer.native-origin-smoke/1' and smoke.get('status') == 'passed' and smoke.get('passed') is True,
            'Signed native origin smoke did not pass')
    require(smoke.get('identifier') == IDENTIFIER and smoke.get('origin') == DEV_ORIGIN and smoke.get('core_ipc') is True
            and smoke.get('custom_ipc') is True and smoke.get('smoke_enabled') is True and smoke.get('application_launched') is True
            and smoke.get('owned_process_exited') is True and smoke.get('commands') == ['plugin:app|identifier', 'live_set_v2_smoke_enabled', 'live_set_v2_report']
            and smoke.get('binary_sha256') == digest(binary), 'Native origin smoke does not qualify this exact binary/origin')
    native_tree = git(source, 'ls-tree', '-rz', 'HEAD', '--', 'src-tauri', 'crates', 'labs/guest-rtc/vendor')
    value = {
        'schema': 'producer.unreleased-mac-dev/1',
        'created_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'source_sha': sha, 'infrastructure_sha': infrastructure, 'version': version,
        'native_tree_sha256': hashlib.sha256(native_tree).hexdigest(),
        'engine_lock_sha256': ENGINE_PIN, 'engine_run_id': os.environ['ENGINE_RUN'],
        'engine_archive_sha256': os.environ['ENGINE_ARCHIVE_SHA256'],
        'engine_manifest_sha256': digest(output / 'engine-manifest.json'),
        'features': FEATURES, 'profile': 'release; line-tables-only symbols; packed split debug info',
        'rustc': subprocess.check_output(['rustc', '--version'], text=True).strip(),
        'bundle_identifier': IDENTIFIER, 'display_name': info.get('CFBundleDisplayName'),
        'binary_sha256': digest(binary), 'binary_uuid': binary_uuids,
        'artifact': {'name': archive.name, 'size_bytes': archive.stat().st_size, 'sha256': digest(archive)},
        'artifact_visibility': 'UNRELEASED GitHub Actions artifact on a PUBLIC repository; not collaborator-private; no customer profile or credentials included.',
        'developer_id_team': team.group(1), 'notarized': notarized, 'notary_submission_id': submission or None,
        'bootstrap_url': 'http://localhost:1436/?roomInspect=1',
        'runtime_origin': DEV_ORIGIN, 'dev_config_sha256': digest(output / 'dev-config.json'),
        'ipc_origin_policy': 'Exact loopback frontendDist URL is the release app origin; existing local default capabilities remain unchanged; no remote capability grants added.',
        'profile_relative_database': IDENTIFIER + '/sets-v2-dev/producer.db',
        'frontend_scope': 'Dev-only URL frontendDist; native startup loads live Vite 1436, whose working-tree provenance must be captured separately. Production bundled frontend configuration is unchanged.',
        'system_extension_installation': False,
        'virtual_camera_runtime': 'mac-virtualcam plugin retained for an existing installed ai.boomin.producer.camera-extension provider; installer qualification is outside this dev artifact.',
        'permissions': 'Existing profile is preserved by identity; macOS TCC/Keychain may prompt after signing/executable changes.',
        'updater_artifacts': False, 'production_updater_endpoints': False, 'public_release': False,
        'application_launched': True, 'native_runtime_acceptance': 'core+custom IPC smoke only; devices and RTC not qualified',
        'native_origin_smoke_sha256': digest(smoke_path),
        'tooling_sha256': {name: digest(tools / name) for name in ['ci-network-mac-dev.sh', 'ci-network-mac-dev.py', 'ci-network-mac-dev-origin-smoke.mjs']},
    }
    (output / 'provenance.json').write_text(json.dumps(value, indent=2) + '\n')
    print('Wrote unreleased candidate provenance; source/native/engine/signature/symbol gates passed.')


def self_test():
    import tempfile
    dev = {'identifier': IDENTIFIER, 'build': {'devUrl': DEV_ORIGIN}}
    original_dev = json.dumps(dev, sort_keys=True)
    production = {'identifier': 'ai.boomin.producer', 'build': {'devUrl': 'http://localhost:1420', 'frontendDist': '../dist'}}
    original_production = json.dumps(production, sort_keys=True)
    config = isolated_config(dev, Path('/candidate'))
    require(config['identifier'] == IDENTIFIER and config['build']['devUrl'] == DEV_ORIGIN and config['build']['frontendDist'] == DEV_ORIGIN, 'Exact dev identity/origin test failed')
    require('capabilities' not in config.get('app', {}).get('security', {}), 'Unexpected inline IPC permissions')
    require(config['bundle']['createUpdaterArtifacts'] is False and config['plugins']['updater']['endpoints'] == [], 'Updater policy test failed')
    require(not any(k in DEV_ENTITLEMENTS for k in FORBIDDEN_ENTITLEMENTS), 'Entitlement scope test failed')
    forbidden = [production]
    for url in ['http://localhost:1437', 'http://127.0.0.1:1436', 'https://localhost:1436', 'http://localhost.evil:1436', 'https://producer.dev', DEV_ORIGIN + '/other', DEV_ORIGIN + '?redirect=1']:
        forbidden.append({'identifier': IDENTIFIER, 'build': {'devUrl': url}})
    forbidden.extend([
        {**dev, 'build': {**dev['build'], 'frontendDist': 'https://outside.example'}},
        {**dev, 'app': {'windows': [{'label': 'main', 'url': 'https://outside.example'}]}},
        {**dev, 'app': {'windows': [{'label': 'other'}]}},
        {**dev, 'app': {'security': {'capabilities': [{'remote': {'urls': ['http://*']}}]}}},
    ])
    for invalid in forbidden:
        try:
            isolated_config(invalid, Path('/candidate'))
            raise RuntimeError('Unexpected identity/origin/grant was incorrectly accepted')
        except ValueError:
            pass
    require(json.dumps(dev, sort_keys=True) == original_dev and json.dumps(production, sort_keys=True) == original_production, 'Source/production input was modified')
    with tempfile.TemporaryDirectory() as folder:
        root = Path(folder)
        names = ['Frameworks/libobs.framework/Versions/A/libobs', 'Frameworks/libobs-metal.dylib',
                 'PlugIns/obs-browser.plugin/Contents/MacOS/obs-browser',
                 'PlugIns/mac-virtualcam.plugin/Contents/MacOS/mac-virtualcam']
        for name in names:
            p = root / name; p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(b'fixture')
        lock = {'fixture': True}
        manifest = {'lock': lock, 'files': {name: digest(root / name) for name in names}}
        (root / 'manifest.json').write_text(json.dumps(manifest))
        check_manifest(root, lock)
        for mutate in [lambda: (root / names[0]).write_bytes(b'changed'),
                       lambda: manifest['files'].update({'../outside': '0' * 64})]:
            (root / names[0]).write_bytes(b'fixture')
            mutate(); (root / 'manifest.json').write_text(json.dumps(manifest))
            try:
                check_manifest(root, lock)
                raise RuntimeError('Invalid engine fixture was incorrectly accepted')
            except ValueError:
                pass
        try:
            check_manifest(root, {'another': 'lock'})
            raise RuntimeError('Different engine lock was incorrectly accepted')
        except ValueError:
            pass
    print('PASS: exact release-dev origin/default capabilities, production/source immutability, updater/entitlement policy and engine integrity fixtures; no build/signing/app launch.')


if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else ''
    if mode == 'self-test': self_test()
    elif mode == 'prepare' and len(sys.argv) == 4: prepare(Path(sys.argv[2]).resolve(), Path(sys.argv[3]).resolve())
    elif mode == 'verify-engine' and len(sys.argv) == 4: verify_engine(Path(sys.argv[2]).resolve(), Path(sys.argv[3]).resolve())
    elif mode == 'receipt' and len(sys.argv) == 6: receipt(*[Path(arg).resolve() for arg in sys.argv[2:]])
    else: raise SystemExit('Expected prepare SOURCE OUT, verify-engine SOURCE ENGINE, receipt SOURCE APP OUTPUT TOOLS, or self-test')
