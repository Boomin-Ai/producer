#!/usr/bin/env python3
"""Restore an immutable Actions artifact by ID and verify its archive digest."""
import hashlib
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

artifact, expected_digest, directory = sys.argv[1:]
assert re.fullmatch(r'[1-9][0-9]{0,19}', artifact), 'Invalid artifact ID'
assert re.fullmatch(r'sha256:[0-9a-f]{64}', expected_digest), 'Missing artifact digest'
repo = os.environ['GITHUB_REPOSITORY']
out = Path(directory)
out.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='producer-staged-') as temp:
    archive = Path(temp) / 'artifact.zip'
    with archive.open('wb') as stream:
        subprocess.run(['gh', 'api', '--allow-escape-sequences', f'repos/{repo}/actions/artifacts/{artifact}/zip'], stdout=stream, timeout=300, check=True)
    digest = hashlib.sha256()
    with archive.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    assert 'sha256:' + digest.hexdigest() == expected_digest, 'Actions artifact archive digest mismatch'
    with zipfile.ZipFile(archive) as z:
        for member in z.infolist():
            if member.is_dir():
                continue
            name = PurePosixPath(member.filename)
            assert not name.is_absolute() and '\\' not in member.filename and ':' not in member.filename and '..' not in name.parts
            dest = out.joinpath(*name.parts)
            dest.parent.mkdir(parents=True, exist_ok=True)
            with z.open(member) as src, dest.open('xb') as dst:
                shutil.copyfileobj(src, dst)
print(f'Restored verified Actions artifact {artifact}')
