#!/usr/bin/env python3
"""Exercise actual native workspace commands during paired GPU recording.
Only runs against the explicitly marked public-video QA profile. No capture,
network account, production profile, or user media is modified.
"""
import argparse,json,os,pathlib,subprocess,time,hashlib
p=argparse.ArgumentParser();p.add_argument('--binary',type=pathlib.Path,required=True);p.add_argument('--profile',type=pathlib.Path,required=True);p.add_argument('--evidence',type=pathlib.Path,required=True);p.add_argument('--keep-open',action='store_true',help='Exercise recording without restarting the dev window');a=p.parse_args()
root=a.profile.resolve();assert json.loads((root/'visual-fixture.json').read_text())['kind']=='native-visual-qa'
env=os.environ.copy();env['PRODUCER_NATIVE_ROOM_HOME']=str(root);b=str(a.binary.resolve())
def req(c,ok=True):
    q=subprocess.run([b,'--request',json.dumps(c)],env=env,capture_output=True,text=True,timeout=15);assert not q.returncode,q.stderr
    r=json.loads(q.stdout);assert r['ok']==ok,r
    return r.get('state',r)
def state():return req({'op':'state'})
s=state();assert not s['recording'] and s['project']['production']['title']=='Classic / Native light & motion'
original=s['project']['workspace'];before=s;rows=[];latencies=[]
def action(c,ok=True):
    t=time.monotonic();v=req({'op':'workspace','command':c},ok);latencies.append((time.monotonic()-t)*1000)
    s=state();assert s['recording'];assert s['revision']==before['revision'];assert s['project']['production']==before['project']['production'];assert s['refusedFrames']==before['refusedFrames']
    rows.append({'action':c,'accepted':ok,'revision':s['revision'],'outputFrames':s['outputFrames']})
    return v
req({'op':'play'});req({'op':'record','enabled':True});start=time.monotonic()
try:
    for panel in ('sources','controls','mixer','scenes'):
        for edge in ('top','right','bottom','left'):
            action({'action':'move','panel':panel,'edge':edge})
            action({'action':'resize','edge':edge,'size':300 if edge in ('left','right') else 220})
            action({'action':'collapse','edge':edge,'collapsed':True})
            action({'action':'activate','panel':panel})
        action({'action':'visibility','panel':panel,'visible':False})
        action({'action':'activate','panel':panel})
    for edge in ('top','bottom'):
        action({'action':'move','panel':'timeline','edge':edge})
    valid=state()['project']['workspace']
    for c in ({'action':'move','panel':'timeline','edge':'left'},{'action':'resize','edge':'bottom','size':9000}):
        action(c,False);assert state()['project']['workspace']==valid
    req({'op':'clearError'})
    action({'action':'reset'})
    while time.monotonic()-start<16:time.sleep(.15)
finally:
    req({'op':'record','enabled':False});req({'op':'pause'})
for _ in range(120):
    end=state()
    if end['take']['phase'] in ('saved','failed'):break
    time.sleep(.1)
assert end['take']['phase']=='saved',end['take'];assert not end['error'],end['error']
assert end['revision']==before['revision'];assert all(b>a for a,b in zip(before['outputFrames'],end['outputFrames']))
assert end['moviePlayback']['missingPresentations']==before['moviePlayback']['missingPresentations']
# Persist an unmistakable arrangement, restart the same dev app, and verify it.
req({'op':'workspace','command':{'action':'move','panel':'mixer','edge':'left'}})
req({'op':'workspace','command':{'action':'resize','edge':'left','size':310}})
req({'op':'workspace','command':{'action':'collapse','edge':'left','collapsed':True}})
saved=state()['project']['workspace'];assert json.loads((root/'room.json').read_text())['workspace']==saved
if not a.keep_open:
    req({'op':'quit'});time.sleep(1)
    with (root/'native.log').open('a') as log:child=subprocess.Popen([b],env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
    for _ in range(100):
        try:s=state();break
        except (AssertionError,subprocess.TimeoutExpired):time.sleep(.1)
    else:raise AssertionError('Dev did not reopen')
    assert s['project']['workspace']==saved
req({'op':'workspace','command':{'action':'reset'}})
req({'op':'play'})
latencies.sort()
result={'scope':'Native workspace and public MOV recording; no physical camera/mic or mouse automation qualification','candidateSha256':hashlib.sha256(a.binary.read_bytes()).hexdigest(),'workspaceCommandsDuringRecording':len(rows),'commandRoundtripP50Ms':latencies[len(latencies)//2],'commandRoundtripP99Ms':latencies[-1],'sameRenderRevision':True,'zeroNewMissingMoviePresentations':True,'zeroNewGpuRefusals':True,'reopenedLayoutMatchesDisk':not a.keep_open,'recording':end['recordPath'],'outputsBefore':before['outputFrames'],'outputsAfter':end['outputFrames'],'cpuP99Ms':end['cpuP99Ms'],'rows':rows}
a.evidence.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items() if k!='rows'}))
