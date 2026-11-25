#!/usr/bin/env python3
"""Native GPU/paired-recording acceptance using a public video, no device capture.
Requires an explicitly isolated visual fixture profile already open in Native Dev.
Does not contact production, enable capture or upload media.
"""
import argparse,json,os,pathlib,subprocess,time,hashlib,tempfile
p=argparse.ArgumentParser();p.add_argument('--binary',type=pathlib.Path,required=True);p.add_argument('--profile',type=pathlib.Path,required=True);p.add_argument('--movie',type=pathlib.Path,required=True);p.add_argument('--evidence',type=pathlib.Path,required=True);p.add_argument('--seconds',type=float,default=35);a=p.parse_args();assert 14<=a.seconds<=60
root=a.profile.resolve();assert json.loads((root/'visual-fixture.json').read_text())['kind']=='native-visual-qa'
b=str(a.binary.resolve());env=os.environ.copy();env['PRODUCER_NATIVE_ROOM_HOME']=str(root)
def request(d,ok=True):
    s=subprocess.run([b,'--request',json.dumps(d)],env=env,capture_output=True,text=True,timeout=15)
    assert s.returncode==0,(s.returncode,s.stderr)
    r=json.loads(s.stdout);assert r['ok']==ok,r
    return r.get('state',r)
def state():return request({'op':'state'})
s=state();assert not s['recording'] and not s['playing'];assert s['project']['production']['title']=='Classic / Native light & motion'
movie_hash=hashlib.sha256(a.movie.read_bytes()).hexdigest()
grant=root/'movie.json'
if not grant.exists() or json.loads(grant.read_text())['hash']!=movie_hash:
    request({'op':'importMov','path':str(a.movie.resolve())})
    deadline=time.monotonic()+12
    while not grant.exists() or json.loads(grant.read_text())['hash']!=movie_hash:
        assert time.monotonic()<deadline,state().get('error');time.sleep(.1)
s=state();assert not s['error'],s['error']
seq=s['project']['production']['sequences']['main'];m=next(x for x in seq['placements'] if x['source']=='movie');m['range']['duration']={'ticks':'30','rate':1};m['range']['start']={'ticks':'0','rate':1};m['looping']=True
request({'op':'document','command':{'kind':'transaction','operations':[{'op':'replaceSequence','id':'main','value':seq}]}})
rows=[]
for mode in ('dark','light'):
    fixture=json.loads(subprocess.check_output([b,'--visual-fixture',mode],text=True));value=fixture['production']['sets']['studio']
    request({'op':'document','command':{'kind':'transaction','operations':[{'op':'replaceSet','id':'studio','value':value}]}})
    request({'op':'pause'});request({'op':'seek','seconds':0})
    deadline=time.monotonic()+5
    while True:
        ready=state()
        if abs(ready['position'])<0.001 and ready['moviePlayback']['frameReady'] and abs(ready['moviePlayback']['decodedAt'])<0.001:break
        assert time.monotonic()<deadline,'First movie frame not presented';time.sleep(.1)
    request({'op':'play'})
    before=state();start=request({'op':'record','enabled':True});samples=[];start_at=time.monotonic()
    try:
        edited=False
        while time.monotonic()-start_at<a.seconds:
            s=state();assert not s['error'],s['error'];samples.append({k:s[k] for k in ('position','renderFrames','outputFrames','refusedFrames','cpuP99Ms','moviePlayback')})
            if not edited and time.monotonic()-start_at>2:
                # One-element edit through the exact public transaction the
                # Assistant will use; keep source/children/Show/timing intact.
                style=value['layouts']['landscape']['root']['children'][1]['style'];style['grain']=.035
                request({'op':'document','command':{'kind':'transaction','operations':[{'op':'setSurface','set':'studio','layout':'landscape','path':['root','glass'],'style':style}]}})
                for panel in ('sources','controls'):request({'op':'panel','panel':panel,'visible':False})
                request({'op':'timelineDock','edge':'top'})
                for panel in ('sources','controls'):request({'op':'panel','panel':panel,'visible':True})
                request({'op':'timelineDock','edge':'bottom'});edited=True
            time.sleep(.15)
    finally:
        request({'op':'record','enabled':False});request({'op':'pause'})
    deadline=time.monotonic()+12
    while True:
        end=state()
        if end['take']['phase'] in ('saved','failed'):break
        assert time.monotonic()<deadline,'Finalization did not complete';time.sleep(.1)
    assert end['take']['phase']=='saved',end['take'];assert not end['error'],end['error'];assert end['refusedFrames']==before['refusedFrames']
    assert all(y>x for x,y in zip(before['outputFrames'],end['outputFrames']))
    assert end['moviePlayback']['missingPresentations']==before['moviePlayback']['missingPresentations'],(before['moviePlayback'],end['moviePlayback'])
    presence=json.loads(subprocess.check_output(['swift','-module-cache-path',str(pathlib.Path(tempfile.gettempdir())/'producer-visual-swift-cache'),str(pathlib.Path(__file__).with_name('check-video-presence.swift')),end['recordPath']],text=True,timeout=90))
    assert presence and all(r['blankFrames']==0 for r in presence),presence
    assert all(r['maxIdenticalSampleRun']<8 for r in presence),presence
    rows.append({'mode':mode,'pixelVisibility':presence,'recording':end['recordPath'],'before':{k:before[k] for k in ('outputFrames','refusedFrames','moviePlayback')},'after':{k:end[k] for k in ('outputFrames','refusedFrames','cpuP99Ms','moviePlayback')},'samples':samples,'elementEditAndDockRoundtrip':edited})
a.evidence.write_text(json.dumps({'scope':'Native GPU public-video check, not camera/mic or full beta qualification','secondsPerMode':a.seconds,'runs':rows},indent=2)+'\n')
print(json.dumps({'modes':[r['mode'] for r in rows],'savedPairs':len(rows),'zeroNewGpuSubmissionRefusals':True,'evidence':str(a.evidence)}))
