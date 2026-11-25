#!/usr/bin/env python3
"""Opt-in checks against an already running, isolated native development room.
Never starts the production app. --record captures approved camera/screen/mic
and writes only to the native dev profile's recording directory.
"""
import argparse
import json
from pathlib import Path
import subprocess
import time

p = argparse.ArgumentParser()
p.add_argument('--binary', type=Path, required=True)
p.add_argument('--movie', type=Path)
p.add_argument('--record', action='store_true')
p.add_argument('--camera-device', help='Exact device ID from state.cameras; select the physical camera explicitly')
p.add_argument('--originals', nargs='*', choices=['camera','screen','microphone'], default=[],
               help='Explicit consent to retain these original feeds, including pre-fader mic audio')
p.add_argument('--seconds', type=int, default=20, choices=range(20, 121), metavar='20..120')
p.add_argument('--require-clean-audio', action='store_true')
p.add_argument('--evidence', type=Path, required=True)
a = p.parse_args()
binary = str(a.binary.resolve())
events = []

def command(op, **args):
    started = time.monotonic()
    reply = json.loads(subprocess.check_output([binary, '--request', json.dumps(dict(op=op, **args))], text=True, timeout=12))
    if not reply.get('ok'):
        raise RuntimeError(reply.get('error', reply))
    if op != 'state':
        events.append(dict(op=op, elapsedMs=round((time.monotonic()-started)*1000, 2)))
    return reply['state']

def wait_for(predicate, seconds=10):
    deadline = time.monotonic()+seconds
    while time.monotonic() < deadline:
        s = command('state')
        if predicate(s): return s
        time.sleep(.2)
    raise RuntimeError('Native check timed out: '+json.dumps({k:s[k] for k in ['error','nativeStatus','sourceFrames','audioFrames']}))

initial = command('state')
assert not initial['recording'], 'Stop any dev recording before this opt-in test'
assert not initial['take']['phase'] in ['starting','recording','finalizing'], 'Let the existing take finalize first'
scene = initial['project']['scene']
library = initial['project']['production']['sets'][scene]
command('canvasSize', target='landscape', width=1080, height=1080)
command('canvasSize', target='vertical', width=1200, height=1500)
name = 'native-agent-'+str(int(time.time()))
s = command('scaffoldSet', id=name, title='PRODUCER / NATIVE ROOM')
assert s['assistantContext']['renderTargets']['landscape'] == {'width':1080,'height':1080}
assert s['project']['production']['sets'][scene] == library
made = s['project']['production']['sets'][name]['layouts']
assert (made['landscape']['width'], made['landscape']['height']) == (1080,1080)
assert (made['vertical']['width'], made['vertical']['height']) == (1200,1500)
assert s['project']['production']['shows']['native-show']['set'] == name
command('canvasSize', target='landscape', width=1920, height=1080)
command('canvasSize', target='vertical', width=1080, height=1920)
command('canvasView', view='both')
# Leave a clean default-sized paired demonstration on output after proving
# custom authored sizes, including deriving a Set from another generated Set.
name += '-wide'
command('scaffoldSet', id=name, title='PRODUCER / NATIVE ROOM')
for edge in ['top','bottom']: command('timelineDock', edge=edge)
for panel in ['sources','controls','timeline']:
    command('panel', panel=panel, visible=False)
    command('panel', panel=panel, visible=True)
command('gain', source='microphone', gain=1., muted=False)
command('seek', seconds=5.)

result = dict(profile='isolated-native-dev', controlsPassed=True, room=s['project']['room'], scene=name, events=events)
if a.movie:
    command('importMov', path=str(a.movie.resolve()))
    wait_for(lambda s: s['project']['production']['sources']['movie']['asset'].startswith('movie-') and s['project']['production']['sources']['movie']['asset'] != 'movie-asset')
    command('trim', clip='movie-clip', start=4., duration=8., source_in=0.)
    command('seek', seconds=5.)
    wait_for(lambda s: s['sourceFrames'][2]>0)
    result['moviePassed']=True
if a.record:
    assert a.movie, '--record requires the synthetic --movie fixture'
    if a.camera_device:
        command('cameraDevice', id=a.camera_device)
    command('capture', camera=True, screen=True, mic=True)
    capture_started = command('state')
    # Counts survive a device restart. Require new, recent frames instead of
    # treating a previously captured frame as proof that capture is ready.
    before = wait_for(lambda s: all(s['sourceFrames'][i] > capture_started['sourceFrames'][i] + 2
                                   and -100. < s['frameAgeMs'][i] < 250. for i in [0, 1])
                      and s['sourceFrames'][2] > 0
                      and s['audioFrames'] > capture_started['audioFrames'] + 2048, 20)
    command('recordOriginals', **{k:k in a.originals for k in ['camera','screen','microphone']})
    command('play')
    command('record', enabled=True)
    started = wait_for(lambda s: s['take']['phase'] in ['recording','failed'], 10)
    assert started['take']['phase']=='recording', started['take']
    result['recordPath']=started['recordPath']
    start = time.monotonic()
    samples=[]
    try:
        for i in range(a.seconds):
            if i in [3,8,13]: command('seek', seconds=5.+(i%3))
            if i==6: command('trim', clip='movie-clip', start=4., duration=7., source_in=1.)
            s=command('state')
            assert s['take']['phase']!='failed', s['take']
            sample={k:s[k] for k in ['position','playing','renderFrames','refusedFrames','cpuP99Ms','sourceFrames','outputFrames','audioFrames','audioDropped','audioDiagnostics','nativeStatus','error']}
            sample['elapsedSeconds']=round(time.monotonic()-start,4)
            samples.append(sample)
            time.sleep(max(0.,start+i+1-time.monotonic()))
    finally:
        command('record', enabled=False)
    finished=wait_for(lambda s:s['take']['phase'] in ['saved','failed'], 15)
    assert finished['take']['phase']=='saved', finished['take']
    command('pause')
    command('seek', seconds=5.)
    final = command('state')
    result['take']=final['take']
    command('recordOriginals', **initial['originals'])
    result.update(recordedSeconds=round(time.monotonic()-start,2), samples=samples,
        beforeRecording={k:before[k] for k in ['sourceFrames','audioFrames','audioDropped','audioDiagnostics','refusedFrames']},
        afterRecording={k:final[k] for k in ['sourceFrames','audioFrames','audioDropped','audioDiagnostics','refusedFrames']},
        microphoneDropDelta=samples[-1]['audioDropped']-before['audioDropped'],
        refusedFrameDelta=samples[-1]['refusedFrames']-before['refusedFrames'],
        sourceFrameDeltas=[last-first for first,last in zip(before['sourceFrames'],final['sourceFrames'])],
        audioDiagnosticsDelta={k:final['audioDiagnostics'][k]-before['audioDiagnostics'][k]
            for k in final['audioDiagnostics'] if k not in ['timestampMinDelta','timestampMaxDelta']})
a.evidence.parent.mkdir(parents=True,exist_ok=True)
a.evidence.write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k not in ['events','samples']}))
if a.record:
    assert all(n > 0 for n in result['sourceFrameDeltas']), 'A required visual source stopped delivering frames'
if a.require_clean_audio:
    assert a.record, '--require-clean-audio requires --record'
    assert result['microphoneDropDelta'] == 0, 'Microphone queue rejected samples; see saved per-cause evidence'
    assert all(v == 0 for v in result['audioDiagnosticsDelta'].values()), 'Audio discontinuity or mixer underflow; see saved evidence'
