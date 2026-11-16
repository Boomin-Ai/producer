#!/usr/bin/env python3
"""Author and exercise nested composition through the real authenticated stdio boundary.
No desktop profile, media device, external cue dispatch or renderer is touched.
"""
import argparse,copy,json,subprocess,tempfile

def run(binary):
    fixture=json.loads(subprocess.check_output([binary,'nested-fixture']))
    with tempfile.TemporaryDirectory(prefix='producer-nested-proof-') as tmp:
        def start():
            return subprocess.Popen([binary,'serve','--store',tmp,'--document-id',fixture['id']],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        process=start()
        def raw(method,**kwargs):
            process.stdin.write(json.dumps({'method':method,**kwargs})+'\n');process.stdin.flush()
            line=process.stdout.readline();assert line,process.stderr.read()
            return json.loads(line)
        def rpc(method,**kwargs):
            r=raw(method,**kwargs);assert r['ok'],r
            return r['result']
        session=rpc('hello')['session'];revision=0
        def transaction(operations, saved=True):
            nonlocal revision
            command={'kind':'transaction','operations':operations}
            ticket=rpc('issue',session=session,expected=str(revision),command=command)['ticket']
            r=rpc('submit',session=session,ticket=ticket,command=command)
            assert (r['outcome']['status']=='saved')==saved,r
            assert rpc('submit',session=session,ticket=ticket,command=command)==r
            if saved:revision+=1
            return ticket,command,r
        transaction([{'op':'setTitle','title':fixture['title']}])
        for collection,op in [('assets','addAsset'),('sources','addSource'),('components','addComponent'),('sets','addSet')]:
            for key,value in fixture[collection].items():transaction([{'op':op,'id':key,'value':value}])
        # References must exist on every saved revision, not only at the end.
        for key in ['pulse','motif','timeline','opener']:
            transaction([{'op':'addSequence','id':key,'value':fixture['sequences'][key]}])
        for key,value in fixture['shows'].items():transaction([{'op':'addShow','id':key,'value':value}])
        inspected=rpc('inspect',session=session);assert inspected['document']==fixture
        def evaluate():
            r=rpc('evaluate',session=session,sequence='timeline',time={'ticks':'1','rate':2})
            assert [x['value']['value'] for x in r['values']]==[0.25,0.75]
        evaluate()
        broken=copy.deepcopy(fixture['sequences']['timeline'])
        broken['instances'][1]['sourceBindings']=[]
        rejection=transaction([{'op':'setTitle','title':'must not persist'}, {'op':'replaceSequence','id':'timeline','value':broken}],False)
        assert rejection[2]['outcome']['error']['code']=='DRIVER_CONFLICT',rejection
        assert rpc('inspect',session=session)['digest']==inspected['digest']
        assert not raw('evaluate',session='untrusted',sequence='timeline',time={'ticks':'0','rate':1})['ok']
        events=[{'kind':'start','at':'0'}, {'kind':'advance','at':'500000000'}, {'kind':'advance','at':'1000000000'},
                {'kind':'seek','at':'1100000000','to':{'ticks':'0','rate':1}}, {'kind':'advance','at':'2100000000'},
                {'kind':'pause','at':'2100000000','owner':'operator'}, {'kind':'advance','at':'3000000000'},
                {'kind':'resume','at':'3000000000','owner':'operator'}, {'kind':'advance','at':'3500000000'},
                {'kind':'stop','at':'3500000000'}, {'kind':'start','at':'4000000000'}]
        def simulate():
            result=rpc('simulateTimeline',session=session,sequence='timeline',looping=True,events=events)
            assert result['synthetic']
            s=result['samples'];assert len(s)==len(events)
            assert len(s[0]['cues'])==1 and s[1]['cues'][0]['cue']=='beat'
            assert all(not s[i]['cues'] for i in [3,4,5,6,7,9])
            assert s[6]['paused'] and s[6]['position']=={'ticks':'1','rate':1}
            assert not s[9]['active'] and all(x is None for x in s[9]['values'])
            assert s[-1]['run']=='2' and len(s[-1]['cues'])==1
            assert s[1]['players'][0]['sourceTime']=={'ticks':'3','rate':2}
            assert s[1]['players'][1]['sourceTime']=={'ticks':'5','rate':2}
            return s
        before=simulate()
        excessive=raw('simulateTimeline',session=session,sequence='timeline',looping=True,events=[events[0]]*129)
        assert not excessive['ok'] and excessive['error']['code']=='TIMELINE_LIMIT'
        assert rpc('inspect',session=session)['digest']==inspected['digest']
        rpc('checkpoint',session=session)
        process.stdin.close();assert process.wait(timeout=30)==0
        process=start();session=rpc('hello')['session']
        assert rpc('inspect',session=session)['document']==fixture
        ticket,command,result=rejection
        assert rpc('submit',session=session,ticket=ticket,command=command)==result
        evaluate();after=simulate()
        assert before[0]['execution']!=after[0]['execution']
        for rows in [before,after]:
            for row in rows:del row['execution']
        assert before==after
        # A legal source-only document can still produce an oversized multi-
        # sample response. Reject that response without emitting partial output.
        large=copy.deepcopy(fixture)
        large['sequences']={'opener':copy.deepcopy(fixture['sequences']['opener'])}
        large['shows']['pilot']['segments'][0]['sequence']='opener'
        q=large['sequences']['opener'];q['tracks']=[];q['instances']=[];q['cues']=[]
        template=copy.deepcopy(q['placements'][0]);template.update(source='host',sourceIn={'ticks':'0','rate':1},speed={'numerator':1,'denominator':1},looping=False)
        q['placements']=[dict(template,id=f'placement-{i:04d}-'+('x'*40)) for i in range(4096)]
        command={'kind':'import','document':large}
        ticket=rpc('issue',session=session,expected=str(revision),command=command)['ticket']
        assert rpc('submit',session=session,ticket=ticket,command=command)['outcome']['status']=='saved'
        before_guard=rpc('inspect',session=session)['digest']
        oversized=raw('simulateTimeline',session=session,sequence='opener',events=[{'kind':'start','at':'0'}]*15)
        assert not oversized['ok'] and oversized['error']['code']=='TIMELINE_LIMIT',oversized
        assert 'response' in oversized['error']['message']
        overwork=raw('simulateTimeline',session=session,sequence='opener',events=[{'kind':'start','at':'0'}]*16)
        assert not overwork['ok'] and overwork['error']['code']=='TIMELINE_LIMIT'
        assert 'aggregate' in overwork['error']['message']
        assert rpc('inspect',session=session)['digest']==before_guard
        rpc('disconnect',session=session);process.stdin.close();assert process.wait(timeout=30)==0
        print(json.dumps({'incrementalCommits':revision,'nestedDepth':2,'independentPlayers':2,'simulationEvents':len(events),'replayedIdenticalAfterRestart':True,'rejectedConflictingEditAtomically':True,'skippedEffectsStaySilent':True,'responseBudgetRejected':True,'fixtureDigest':inspected['digest']},indent=2))
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--binary',required=True);run(p.parse_args().binary)
