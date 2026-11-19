#!/usr/bin/env python3
"""Bounded release-only FileStore proof. Every failure stays in the output record."""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import sys

parser = argparse.ArgumentParser()
parser.add_argument('--binary', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
binary = Path(args.binary).resolve()
output = Path(args.output)
result = dict(recordedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
              scope='Synthetic isolated FileStore, requested heap and self RSS. No desktop/media/GPU qualification.',
              binarySha256=hashlib.sha256(binary.read_bytes()).hexdigest(), runs=[])
failed = False
for shape in ('--bytes', '--dense', '--journal'):
    try:
        p = subprocess.run([str(binary), shape], text=True, capture_output=True, timeout=600)
        try:
            data = json.loads(p.stdout)
        except json.JSONDecodeError:
            data = dict(rawStdout=p.stdout)
        run = dict(shape=shape, exitCode=p.returncode, stderr=p.stderr, result=data)
    except subprocess.TimeoutExpired as exc:
        run = dict(shape=shape, exitCode='timeout', stderr=str(exc), result={})
    result['runs'].append(run)
    output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(dict(shape=shape, exitCode=run['exitCode'])), flush=True)
    failed |= run['exitCode'] != 0
sys.exit(int(failed))
