#!/usr/bin/env python3
"""Opt-in Native Dev check: edit a committed take while its recorder continues.
--live additionally requires camera, screen and mic and retains their originals.
Writes private evidence locally; never opens or changes production.
"""
import argparse, copy, json, subprocess, time
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('--binary',type=Path,required=True)
p.add_argument('--record',action='store_true',required=True,help='Consent to record the isolated dev outputs locally')
p.add_argument('--live',action='store_true',help='Require approved camera, screen and mic, and retain their originals locally')
p.add_argument('--evidence',type=Path,required=True)
a=p.parse_args();binary=str(a.binary.resolve());events=[]
def call(op,**args):
    start=time.monotonic()
    r=json.loads(subprocess.check_output([binary,'--request',json.dumps(dict(op=op,**args))],text=True,timeout=12))
    if op!='state':events.append(dict(op=op,elapsedMs=round((time.monotonic()-start)*1000,2),ok=r['ok'],error=r.get('error')))
    return r
def c(op,**args):
    r=call(op,**args)
    assert r['ok'],r
    return r['state']
def wait(pred,seconds=12):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        s=c('state')
        if pred(s):return s
        time.sleep(.15)
    raise RuntimeError('Timed out: '+json.dumps({k:s.get(k) for k in ['error','nativeStatus','takePlayback','sourceFrames']}))
def sec(t):return int(t['ticks'])/t['rate']
def clip(s):return next(p for p in s['project']['production']['sequences']['main']['placements'] if p['id']=='take-clip')
def ready(s):return s['takePlayback'].get('frameReady') and s['takePlayback'].get('draws')==[1,1]
def seek(at):
    prior=c('state')['takePlayback'].get('generation',0)
    c('seek',seconds=at)
    return wait(lambda s:ready(s) and s['takePlayback'].get('generation',0)>prior and abs(s['position']-at)<.01)
initial=c('state');assert not initial['recording'] and initial['take']['phase'] not in ['starting','recording','finalizing']
c('pause')
c('capture',camera=a.live,screen=a.live,mic=a.live)
if a.live:
    c('seek',seconds=5)
    base=initial['sourceFrames']
    wait(lambda s:all(s['sourceFrames'][i]>base[i] for i in range(3)) and s['microphonePeak']>=0)
c('canvasView',view='both')
for target,w,h in [('landscape',1920,1080),('vertical',1080,1920)]:c('canvasSize',target=target,width=w,height=h)
c('recordOriginals',camera=a.live,screen=a.live,microphone=a.live)
c('panel',panel='controls',visible=True)
# Same source and media placements survive take binding/refresh.
before=c('state'); live={k:before['project']['production']['sources'][k] for k in ['camera','screen','movie','microphone']}
record=c('record',enabled=True);started=time.monotonic();record_path=record['recordPath']
try:
    s=wait(lambda s:s['take']['path']==record_path and s['take']['phase']=='recording' and s['take']['head'] and all(s['take']['head']['tracks']))
    take=Path(s['recordPath']).name
    c('takePlace',name=take,track=0,start=0,duration=1)
    s=seek(.3)
    frozen=copy.deepcopy(s['takePlayback']); old_end=sec(frozen['available']['start'])+sec(frozen['available']['duration'])
    c('trim',clip='take-clip',start=0,duration=.8,source_in=.5)
    preserved=copy.deepcopy(clip(c('state')))
    bad=call('trim',clip='take-clip',start=0,duration=1000,source_in=0)
    assert not bad['ok'] and clip(c('state'))==preserved
    s=wait(lambda s:s['take']['head']['tracks'][0]['index']>=3)
    prior=s['takePlayback']['generation']
    c('takeRefresh')
    s=wait(lambda s:ready(s) and s['takePlayback']['generation']>prior)
    assert clip(s)==preserved and s['takePlayback']['asset']!=frozen['asset']
    new_end=sec(s['takePlayback']['available']['start'])+sec(s['takePlayback']['available']['duration'])
    assert new_end>old_end
    assert all(s['project']['production']['sources'][k]==v for k,v in live.items())
    # Add another cut through the ordinary document contract and prove it can
    # be found even when the first placement is inactive.
    seq=copy.deepcopy(s['project']['production']['sequences']['main'])
    cut=copy.deepcopy(clip(s));cut['id']='take-cut-2';cut['range']={'start':{'ticks':'6','rate':1},'duration':{'ticks':'1','rate':1}};cut['sourceIn']={'ticks':'3','rate':1}
    seq['placements'].append(cut)
    c('document',command={'kind':'transaction','operations':[{'op':'replaceSequence','id':'main','value':seq}]})
    seek(6.2)
    # Cross at least two actual fragment boundaries with live camera/screen,
    # MOV playback, mic and both program encoders still running.
    c('trim',clip='take-clip',start=0,duration=5,source_in=1.2)
    c('trim',clip='movie-clip',start=0,duration=8,source_in=0)
    c('seek',seconds=0)
    c('gain',source='microphone',gain=1,muted=True)
    c('gain',source='movie',gain=1,muted=True)
    c('gain',source='take',gain=1,muted=False)
    c('play');measure_start=c('state');measure=[];deadline=time.monotonic()+12
    while c('state')['position']<4.5:
        assert time.monotonic()<deadline,'Editorial transport did not advance'
        s=c('state');measure.append({k:s[k] for k in ['position','takePlayback','outputFrames','sourceFrames','cpuP99Ms','audioDropped','audioDiagnostics','refusedFrames']});time.sleep(.15)
    # Preserve a failing real-time trace too; never replace it with a pass from
    # static seek checks or relax readiness to accommodate a locked host.
    a.evidence.parent.mkdir(parents=True,exist_ok=True)
    a.evidence.write_text(json.dumps(dict(passed=False,stage='continuous-playback',physicalSourcesRequired=a.live,events=events,measure=measure),indent=2))
    assert all(not s['takePlayback']['error'] for s in measure)
    assert sum(bool(s['takePlayback']['frameReady']) for s in measure)>=len(measure)*.75
    c('pause');seek(2)
    for x in [.1,4.2,1.1,3.2,2.2]:c('seek',seconds=x)
    wait(lambda s:ready(s) and abs(s['position']-2.2)<.01)
    while time.monotonic()-started<20:time.sleep(.25)
    final=c('state');assert final['recording'] and final['take']['head']['revision']>frozen['headRevision']
finally:
    c('record',enabled=False)
    c('pause')
    for source in ['microphone','movie']:
        lane=next(l for l in initial['project']['lanes'] if l['source']==source)
        c('gain',source=source,gain=lane['gain'],muted=lane['muted'])
saved=wait(lambda s:s['take']['phase'] in ['saved','failed'],15);assert saved['take']['phase']=='saved',saved['take']
c('recordOriginals',camera=False,screen=False,microphone=False)
result=dict(passed=True,profile='isolated-native-dev',physicalSourcesRequired=a.live,take=saved['recordPath'],events=events,initialFrozen=frozen,refreshedEnd=new_end,measure=measure,final=final,saved=saved)
a.evidence.parent.mkdir(parents=True,exist_ok=True);a.evidence.write_text(json.dumps(result,indent=2))
print(json.dumps({'passed':True,'take':saved['recordPath'],'events':len(events),'samples':len(measure),'cpuP99MsMax':max(s['cpuP99Ms'] for s in measure)}))
