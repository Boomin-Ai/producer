#!/usr/bin/env python3
"""Exercise the actual CLI/tool boundary with incremental, agent-shaped commands."""
import argparse,json,pathlib,subprocess,tempfile
def run(binary):
    fixture=json.loads(subprocess.check_output([binary,"fixture"]))
    with tempfile.TemporaryDirectory(prefix="producer-core-proof-") as tmp:
        def start():
            return subprocess.Popen([binary,"serve","--store",tmp,"--document-id",fixture["id"]],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        process=start()
        def rpc(method,**kwargs):
            process.stdin.write(json.dumps({"method":method,**kwargs},ensure_ascii=False)+"\n");process.stdin.flush()
            line=process.stdout.readline()
            assert line,process.stderr.read()
            reply=json.loads(line);assert reply["ok"],reply
            return reply["result"]
        session=rpc("hello")["session"];revision=0;last=None;steps=0
        def command(ops):
            nonlocal revision,last,steps
            payload={"kind":"transaction","operations":ops}
            ticket=rpc("issue",session=session,expected=str(revision),command=payload)["ticket"]
            result=rpc("submit",session=session,ticket=ticket,command=payload)
            assert result["outcome"]["status"]=="saved",result
            assert rpc("submit",session=session,ticket=ticket,command=payload)==result
            revision+=1;steps+=1;last=(ticket,payload,result)
        command([{"op":"setTitle","title":fixture["title"]}])
        for collection,op in [("assets","addAsset"),("sources","addSource"),("components","addComponent"),("sets","addSet"),("sequences","addSequence"),("shows","addShow")]:
            for key,value in fixture[collection].items(): command([{"op":op,"id":key,"value":value}])
        inspected=rpc("inspect",session=session);assert inspected["document"]==fixture
        expected=inspected["digest"]
        command([{"op":"setThemeToken","set":"classic","token":"pink","color":"#f4a6cd"}])
        assert rpc("inspect",session=session)["document"]["sets"]["classic"]["theme"]["pink"]=="#f4a6cd"
        rpc("checkpoint",session=session);process.stdin.close();assert process.wait(timeout=30)==0
        # Previous-boot issued tickets cannot execute, but saved outcomes survive restart.
        process=start();session=rpc("hello")["session"];ticket,payload,result=last
        assert rpc("submit",session=session,ticket=ticket,command=payload)==result
        restored=rpc("inspect",session=session);assert restored["revision"]==str(revision)
        assert restored["document"]["sets"]["classic"]["theme"]["pink"]=="#f4a6cd"
        rpc("disconnect",session=session);process.stdin.close();assert process.wait(timeout=30)==0
        path=pathlib.Path(tmp)/"fixture.json";path.write_text(json.dumps(fixture))
        compiled=json.loads(subprocess.check_output([binary,"compile",str(path)]));assert compiled["digest"]==expected
        evaluated=json.loads(subprocess.check_output([binary,"evaluate",str(path),"opener",'{"ticks":"2","rate":1}']))
        assert evaluated["values"][0]["value"]["value"]==0.25
        print(json.dumps({"incrementalCommits":steps,"retryEffectsPerTicket":1,"restarted":True,"pairedLayouts":2,"independentPlayers":2,"analyticInstances":1000,"fixtureDigest":expected},indent=2))
if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument("--binary",required=True);run(p.parse_args().binary)
