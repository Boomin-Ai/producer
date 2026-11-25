#!/usr/bin/env python3
"""Read-only, full decode of a frozen committed native take. Keep private media local."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import subprocess
import time

p = argparse.ArgumentParser()
p.add_argument('--take', type=Path, required=True)
p.add_argument('--ffprobe', type=Path, required=True)
p.add_argument('--evidence', type=Path, required=True)
a = p.parse_args()
root = a.take.resolve()
head = json.loads((root / 'head.json').read_text())
header = json.loads((root / 'take.json').read_text())
assert len(head['tracks']) == len(header['tracks'])
chunks = [(track, i) for track, cap in enumerate(head['tracks']) if cap
          for i in range(cap['index'] + 1)]

def check(key):
    track, index = key
    stem = 'track-%02d-%08d' % (track, index)
    path = root / (stem + '.mp4')
    meta = json.loads((root / (stem + '.json')).read_text())
    assert meta['track'] == track and meta['index'] == index
    if index == head['tracks'][track]['index']:
        assert meta == head['tracks'][track], 'Published head/metadata mismatch'
    assert path.stat().st_size == meta['bytes'], 'Truncated chunk: ' + stem
    digest = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(65536), b''):
            digest.update(block)
    assert digest.hexdigest() == meta['sha256'], 'Chunk hash mismatch: ' + stem
    reply = subprocess.run([str(a.ffprobe.resolve()), '-v', 'error', '-count_frames',
        '-show_entries', 'stream=index,codec_name,codec_type,width,height,nb_read_frames',
        '-of', 'json', str(path)], capture_output=True, text=True, timeout=30)
    assert reply.returncode == 0 and not reply.stderr, (stem, reply.stderr)
    streams = json.loads(reply.stdout)['streams']
    expected = header['tracks'][track]
    declared=set((['video'] if expected['width'] else []) + (['audio'] if expected['audio'] else []))
    reported={s['media'] for s in meta['spans']}
    assert reported and reported <= declared
    assert {s['codec_type'] for s in streams} <= declared
    assert reported <= {s['codec_type'] for s in streams}
    for stream in streams:
        count=stream.get('nb_read_frames','0')
        count=0 if count=='N/A' else int(count)
        assert (count>0)==(stream['codec_type'] in reported), (stem, stream, meta['spans'])
        if stream['codec_type'] == 'video':
            assert (stream['width'], stream['height']) == (expected['width'], expected['height'])
    return dict(chunk=stem, track=track, reportedMedia=sorted(reported), streams=streams, gapsBefore=meta['gapsBefore'])

start = time.monotonic()
# Two decoders keep the live room responsive and bound decoder memory use.
with ThreadPoolExecutor(max_workers=2) as pool:
    rows = list(pool.map(check, chunks))
for i,track in enumerate(header['tracks']):
    seen={m for row in rows if row['track']==i for m in row['reportedMedia']}
    expected=set((['video'] if track['width'] else [])+(['audio'] if track['audio'] else []))
    assert seen==expected,('Required track media never committed',i,seen,expected)
result = dict(path=str(root), frozenHead=head, allDecoded=True, chunks=rows,
              elapsedSeconds=round(time.monotonic()-start, 3))
a.evidence.parent.mkdir(parents=True, exist_ok=True)
a.evidence.write_text(json.dumps(result, indent=2)+'\n')
print(json.dumps(dict(chunksDecoded=len(rows), state=head['state'],
                     elapsedSeconds=result['elapsedSeconds'])))
