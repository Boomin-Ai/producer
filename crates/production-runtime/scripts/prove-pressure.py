#!/usr/bin/env python3
"""Bounded service/graph pressure qualification; preserve failed runs too."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys

p = argparse.ArgumentParser()
p.add_argument('--binary', required=True)
p.add_argument('--output', required=True)
p.add_argument('--repeats', type=int, choices=range(1, 4), default=1)
a = p.parse_args()
binary = Path(a.binary).resolve()
output = Path(a.output)
base = Path(__file__).resolve().parent.parent
root = base.parent.parent

def manifest():
    files = [f for f in base.rglob('*') if f.is_file()
             and not {'target', 'node_modules', 'evidence'}.intersection(f.parts)
             and (f.suffix in ('.rs', '.toml', '.lock', '.py', '.mjs', '.ts')
                  or f.parent == base / 'generated')]
    files.append(root / '.github/workflows/production-core.yml')
    return {str(f.relative_to(root)): hashlib.sha256(f.read_bytes()).hexdigest()
            for f in sorted(files)}

record = dict(recordedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
              scope='Isolated Rust service, real temporary FileStores, self-process requested heap/RSS. No GPU/media/GPUI/app result.',
              platform=platform.platform(), allocatorEnv={'MallocNanoZone': os.environ.get('MallocNanoZone')},
              hostLoadIsolated=False, sourceSha256=manifest(), sourceSnapshotCapturedBeforeVerification=True,
              binarySha256=hashlib.sha256(binary.read_bytes()).hexdigest(),
              gates={'warmupRounds': 4, 'requestedHeapSpanLessThanBytes': 1024**2,
                     'residentSpanLessThanBytes': 64*1024**2, 'ownerReleaseLessThanBytesAboveBaseline': 1024**2,
                     'numericAndEffectInputsP99LessThanMs': 1}, runs=[])
failed = False
for repeat in range(a.repeats):
    for shape in ('--flat', '--nested'):
        try:
            process = subprocess.run([str(binary), shape], text=True, capture_output=True, timeout=600)
            try:
                result = json.loads(process.stdout)
            except json.JSONDecodeError:
                result = dict(rawStdout=process.stdout)
            run = dict(repeat=repeat + 1, shape=shape, exitCode=process.returncode,
                       result=result, stderr=process.stderr)
        except subprocess.TimeoutExpired as exc:
            run = dict(repeat=repeat + 1, shape=shape, exitCode='timeout', result={}, stderr=str(exc))
        record['runs'].append(run)
        output.write_text(json.dumps(record, indent=2) + '\n')
        print(json.dumps(dict(repeat=repeat + 1, shape=shape, exitCode=run['exitCode'],
                              heapSpan=run['result'].get('postWarmupHeapSpanBytes'),
                              rssSpan=run['result'].get('postWarmupResidentSpanBytes'))), flush=True)
        failed |= run['exitCode'] != 0 or run['result'].get('qualificationPassed') is not True
record['sourceUnchangedAfterVerification'] = manifest() == record['sourceSha256']
failed |= not record['sourceUnchangedAfterVerification']
record['allRunsPassed'] = not failed
output.write_text(json.dumps(record, indent=2) + '\n')
sys.exit(int(failed))
