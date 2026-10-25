#!/usr/bin/env python3
"""Check the signed macOS release's camera packaging and provisioning."""
import datetime
import pathlib
import plistlib
import subprocess
import sys
import tempfile


def plist(path):
    return plistlib.loads(path.read_bytes())


def output(*args):
    return subprocess.check_output(args)


def entitlements(bundle):
    return plistlib.loads(output('codesign', '-d', '--entitlements', ':-', str(bundle)))


app = pathlib.Path(sys.argv[1])
contents = app / 'Contents'
info = plist(contents / 'Info.plist')
app_id = info['CFBundleIdentifier']
ext_id = app_id + '.camera-extension'
ext = contents / 'Library' / 'SystemExtensions' / (ext_id + '.systemextension')
ext_info = plist(ext / 'Contents' / 'Info.plist')
assert ext_info['CFBundleIdentifier'] == ext_id, 'Wrong camera extension ID'
assert (ext / 'Contents' / 'MacOS' / ext_info['CFBundleExecutable']).is_file(), 'Missing camera executable'
assert (ext / 'Contents' / 'Resources' / 'placeholder.png').is_file(), 'Missing camera placeholder'
assert info.get('NSSystemExtensionUsageDescription'), 'Missing installation explanation'
profile = plistlib.loads(output('security', 'cms', '-D', '-i', str(contents / 'embedded.provisionprofile')))
team = profile['TeamIdentifier'][0]
assert profile['ExpirationDate'] > datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None), 'Expired profile'
assert profile['Entitlements']['com.apple.application-identifier'] == team + '.' + app_id, 'Wrong profile app'
assert profile['Entitlements'].get('com.apple.developer.system-extension.install') is True, 'Profile cannot install extensions'
assert entitlements(app).get('com.apple.developer.system-extension.install') is True, 'Final signature lost install entitlement'
assert ext_info['CMIOExtension']['CMIOExtensionMachServiceName'] == team + '.' + ext_id, 'Wrong camera service'
plugin = plist(contents / 'PlugIns' / 'mac-virtualcam.plugin' / 'Contents' / 'Info.plist')
assert plugin['OBSCameraDeviceUUID'] == ext_info['OBSCameraDeviceUUID'], 'Camera plugin/device UUID mismatch'
assert plugin.get('ProducerMirrorSupported') is True, 'Virtual camera plugin lacks native mirror support'
with tempfile.TemporaryDirectory(prefix='producer-camera-signing-') as tmp:
    prefix = str(pathlib.Path(tmp) / 'cert')
    output('codesign', '-d', '--extract-certificates=' + prefix, str(app))
    cert = pathlib.Path(prefix + '0').read_bytes()
    assert cert in profile['DeveloperCertificates'], 'Profile does not authorize the signing certificate'
    output('codesign', '-d', '--extract-certificates=' + prefix, str(ext))
    assert pathlib.Path(prefix + '0').read_bytes() == cert, 'App and camera signed with different certificates'
assert ext_info.get('ProducerCameraFormats') == ['1920x1080', '1080x1920'], 'Camera must support both orientations'
assert ext_info['CFBundleVersion'] == '4', 'Stale single-camera extension'
bundles = list((contents / 'Library' / 'SystemExtensions').glob('*.systemextension'))
active_bundles = [b for b in bundles if not plist(b / 'Contents' / 'Info.plist').get('ProducerRetiredCamera')]
assert active_bundles == [ext], 'Bundle must expose one camera provider'
retired = contents / 'Library' / 'SystemExtensions' / (app_id + '.portrait-camera-extension.systemextension')
assert retired in bundles and plist(retired / 'Contents' / 'Info.plist').get('ProducerRetiredCamera') is True
rinfo = plist(retired / 'Contents' / 'Info.plist')
assert (rinfo['CFBundleShortVersionString'], rinfo['CFBundleVersion']) == ('1.2', '3'), 'Retirement helper must match the installed portrait version'
with tempfile.TemporaryDirectory(prefix='producer-migration-signing-') as tmp:
    prefix = str(pathlib.Path(tmp) / 'cert')
    output('codesign', '-d', '--extract-certificates=' + prefix, str(retired))
    assert pathlib.Path(prefix + '0').read_bytes() == cert, 'Migration helper signing mismatch'
assert plugin.get('ProducerSingleCamera') is True, 'Stale two-device camera plugin'
print('PASS: one camera bundle, both formats, native mirroring, signing and provisioning')
