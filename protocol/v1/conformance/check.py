#!/usr/bin/env python3
"""Cross-implementation v1 release gate. All mutations use temporary packages and keys."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
V1 = HERE.parent
FIXTURE = V1 / "field-notes"


def read(path):
    return json.loads(path.read_bytes())


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def call(*args, reject=None):
    result = subprocess.run(args, capture_output=True, text=True, timeout=90)
    if reject:
        if not result.returncode or reject.lower() not in result.stderr.lower():
            raise AssertionError(f"Expected {reject!r}, got {result.returncode}: {result.stderr}")
        return
    if result.returncode:
        raise RuntimeError(result.stderr or str(args))
    return json.loads(result.stdout) if result.stdout.strip() else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--core", default=os.environ.get("PRODUCER_CORE", "producer-core"))
    parser.add_argument("--evidence", type=Path, help="fresh directory for public signed snapshots and rendered frames")
    args = parser.parse_args()
    snap = [sys.executable, V1 / "snapshot.py", "--core", args.core]
    assert call(args.core, "bundle-schema") == read(V1 / "bundle.schema.json")
    assert call(args.core, "schema") == read(V1 / "production.schema.json")
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        # Trust the fixture issuer only for this vector. The fork has a separate temporary key.
        key = root / "fork-key"
        call("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key)
        trust = root / "allowed_signers"
        trust.write_text((HERE / "fixture-signers").read_text() + 'editor@fork.example namespaces="producer.bundle.v1" ' + key.with_suffix(".pub").read_text())
        base = call(*snap, "verify", FIXTURE, "--trust", trust)
        received = root / "received"
        shutil.copytree(FIXTURE, received)
        draft, returned = root / "draft", root / "returned"
        call(*snap, "checkout", received, draft, "--trust", trust)
        call("node", HERE / "peer.cjs", received, draft, base["revision"])
        observations = read(draft / "samples.json")
        assert [s["decodedWidth"] for s in observations] == [320, 160, 160]
        for sample in observations:
            assert sample["revision"] == base["revision"] and sample["samples"] == 288000
            assert sample["peaks"][0] == sample["peaks"][2] == 0 and .08 < sample["peaks"][1] < .09
            assert sample["cues"] == [["sponsor-in", 2], ["sponsor-out", 5]]
            assert [f["placement"] for f in sample["frames"]] == ["open", "sponsor-cut", "sponsor-cut", "outro"]
            assert len({f["pixels"] for f in sample["frames"]}) >= 2
            device = root / "device.json"
            write(device, {"formats":["h264-mp4","pcm-wav","woff2","png"], "maxVideoWidth":sample["decodedWidth"], "maxVideoHeight":180})
            plan = call(args.core, "bundle-plan", received, device)
            assert {k:v["sha256"] for k,v in plan["selected"].items()} == sample["choices"]
            assert plan["liveSlots"] == {"host":"hostCamera","guest":"guest"}
        write(device, {"formats":["pcm-wav"],"maxVideoWidth":160,"maxVideoHeight":90})
        call(args.core, "bundle-plan", received, device, reject="NO_REPRESENTATION")
        child = call(*snap, "freeze", draft, returned, "--key", key, "--trust", trust, "--parent", received, "--at", str(base["authoredAt"] + 1))
        assert child == call(*snap, "verify", returned, "--parent", received, "--trust", trust)
        assert child["revision"] != base["revision"] and child["parent"] == base["revision"]
        assert child["workSha256"] != base["workSha256"] and child["author"] == "editor@fork.example"
        assert base == call(*snap, "verify", FIXTURE, "--trust", trust)
        a,b = (read(p / "production.json") for p in (received,returned))
        cut = next(p for p in a["sequences"]["main"]["placements"] if p["id"] == "sponsor-cut")
        cut["sourceIn"]["ticks"] = "1"
        assert a == b
        m = read(returned / "manifest.json")
        old = read(received / "manifest.json")
        for name in set(old) - {"parent","author","authoredAt","documentSha256"}:
            assert m[name] == old[name], name
        sheet = call(args.core,"bundle-sheet",returned,"reveal")
        assert sheet["range"]["duration"]["ticks"] == "3" and sheet["sourceIn"]["ticks"] == "1"
        assert sheet["resolvedSetup"]["camera"]["model"] == "ALEXA 35"
        assert [b["camera"]["focalLengthMm"] for b in sheet["resolvedBeats"]] == [50,55]
        assert sheet["resolvedBeats"][0]["narration"]["text"] == "Listen to the room."
        assert sheet["actors"]["sponsor"]["name"] == "North Signal"
        assert [i["slot"] for i in sheet["referenceSlots"]] == ["@Image1","@Video1","@Audio1"]
        assert set(sheet["inputs"]) == {"slate","ident","composition"}
        events = [{"kind":"start","at":"0"},{"kind":"advance","at":"2000000000"},{"kind":"advance","at":"5000000000"}]
        write(device, {"formats":["h264-mp4","pcm-wav","woff2","png"],"maxVideoWidth":160,"maxVideoHeight":90})
        run = call(args.core,"bundle-run",returned,device,"main",json.dumps(events))
        assert run["plan"]["selected"]["slate"]["width"] == 160
        samples = run["transport"]["samples"]
        command = root/"command.json"
        write(command,{"kind":"transaction","operations":[{"op":"setTitle","title":"Field Notes, second edition"}]})
        assert call(args.core,"bundle-edit",returned,child["revision"],command)["title"] == "Field Notes, second edition"
        call(args.core,"bundle-edit",returned,base["revision"],command,reject="STALE_REVISION")
        assert [[c["cue"] for c in s["cues"]] for s in samples] == [[],["sponsor-in"],["sponsor-out"]]
        assert [next(p["sourceTime"] for p in s["players"] if p["path"].endswith("/sponsor-cut")) for s in samples] == [None,{"ticks":"1","rate":1},None]
        teaser = call(args.core,"simulate",returned / "production.json","teaser",'[{"kind":"start","at":"0"}]')["samples"][0]
        assert any(p["sourceTime"]=={"ticks":"1","rate":1} for p in teaser["players"] if p["source"]=="picture")

        # A signed completed revision with all required work done. The clock and content hash differ.
        nxt, done = root / "next", root / "complete"
        call(*snap,"checkout",returned,nxt,"--trust",trust)
        f = read(nxt/"manifest.json")
        f["workflow"].update(state="completed",phase="delivery",endedAt=child["authoredAt"],
            review={"actor":"fork-editor","decision":"approved","workSha256":child["workSha256"],"note":"Picture and voice delivery reviewed."})
        # Test workflow independently of changes to the picture or other content.
        write(nxt/"manifest.json",f)
        call(args.core,"bundle-check",nxt,reject="unfinished")
        f["workflow"]["tasks"]["voice"]["state"]="done"
        write(nxt/"manifest.json",f)
        completed = call(*snap,"freeze",nxt,done,"--parent",returned,"--key",key,"--trust",trust,"--at",str(child["authoredAt"]+1))
        assert completed["workSha256"] == child["workSha256"] and completed["revision"] != child["revision"]
        call(*snap,"verify",done,"--parent",received,"--trust",trust,reject="base revision")
        f["shots"]["reveal"]["direction"]["lighting"]="Daylight"
        write(nxt/"manifest.json",f)
        call(args.core,"bundle-check",nxt,reject="approval")
        # The frozen approval remains verifiable after subsequent editing.
        assert call(*snap,"verify",done,"--trust",trust) == completed

        # A director can freeze a storyboard before there is a Set, sequence or media.
        planned = root / "planned"
        planned.mkdir()
        draft_doc = {"schema":"producer.production/1","id":"field-notes","title":"Field Notes"}
        write(planned/"production.json",draft_doc)
        early = {k:old[k] for k in ["protocol","production","author","actors","authoredAt"]}
        early.update(assets={},documentSha256=hashlib.sha256((planned/"production.json").read_bytes()).hexdigest(),
            workflow={"state":"planned","phase":"development","tasks":{}},shots={"reveal":{
            "title":"Record the opening","plannedDuration":{"ticks":"3","rate":1},"takes":{},
            "direction":{"prompt":"Open the episode","action":"Hold on the desk"}}})
        write(planned/"manifest.json",early)
        assert call(args.core,"bundle-sheet",planned,"reveal")["range"] is None
        projected = call(sys.executable,V1/"adapters"/"boomin.py",returned,"reveal","--core",args.core)
        assert projected["schema_version"]=="boomin.workspace.v2"
        exported=projected["objects"]["prompt_sheets"][0]
        assert exported["shot_spec"]["producer"]["revision"]==child["revision"]
        assert exported["prompt_doc"]["mentions"][0]["entity"]["$ref"] in {e["local_id"] for e in projected["objects"]["entities"]}

        for edit, reason in [
            (lambda x:x.update(protocol="producer.bundle/2"),"unknown variant"),
            (lambda x:x["extensions"]["ai.boomin"].update(required=True),"required extension"),
            (lambda x:x["contributions"]["equipment-credit"]["cut"].update(placement="gone"),"unknown placement"),
            (lambda x:x["shots"]["reveal"]["direction"]["camera"].update(iso=0),"camera"),
            (lambda x:x["shots"]["reveal"]["direction"]["mentions"][0].update(end=1000),"span"),
            (lambda x:x["shots"]["reveal"]["direction"]["beats"][0]["range"]["duration"].update(ticks="4"),"beat outside"),
            (lambda x:x["shots"]["reveal"]["takes"]["slate-one"].update(origin="generated"),"generated take"),
            (lambda x:x["mix"][0].update(gainMillidb=100000),"gain"),
            (lambda x:x["workflow"].update(endedAt=x["authoredAt"]),"timestamps"),
            (lambda x:x["assets"]["slate"]["proxies"][0].update(sha256="../other"),"representation"),
            (lambda x:x["assets"]["slate"]["proxies"][0].update(width=161),"aspect"),
        ]:
            bad = copy.deepcopy(m); edit(bad); write(nxt/"manifest.json",bad)
            call(args.core,"bundle-check",nxt,reject=reason)
        # Signatures cover all metadata, including adapter extensions and lifecycle.
        bad = copy.deepcopy(m); bad["workflow"]["phase"]="delivery"
        write(returned/"manifest.json",bad)
        call(*snap,"verify",returned,"--trust",trust,reject="signature")
        write(returned/"manifest.json",m)
        untrusted = root/"untrusted"; untrusted.write_text((HERE/"fixture-signers").read_text())
        call(*snap,"verify",returned,"--trust",untrusted,reject="signature")
        blob = nxt/"blobs"/m["assets"]["slate"]["proxies"][0]["sha256"]
        write(nxt/"manifest.json",m)
        blob.write_bytes(b"broken")
        call(args.core,"bundle-check",nxt,reject="media bytes")
        blob.unlink(); blob.symlink_to(received/"blobs"/m["assets"]["slate"]["proxies"][0]["sha256"])
        call(args.core,"bundle-check",nxt,reject="regular file")
        assert child == call(*snap,"verify",returned,"--trust",trust)
        if args.evidence:
            args.evidence.mkdir(parents=True,exist_ok=False)
            shutil.copytree(returned,args.evidence/"returned")
            shutil.copytree(done,args.evidence/"complete")
            shutil.copyfile(trust,args.evidence/"allowed_signers")
            for name in ["samples.json","landscape-320.png","landscape-160.png","vertical-160.png"]:
                shutil.copyfile(draft/name,args.evidence/name)
            write(args.evidence/"shot-sheet.json",sheet)
        print(json.dumps({"verified":True,"original":base["revision"],"returned":child["revision"],
                          "completed":completed["revision"],"decodedWidths":[s["decodedWidth"] for s in observations],
                          "programSamples":observations[0]["samples"]},indent=2))


if __name__ == "__main__":
    main()
