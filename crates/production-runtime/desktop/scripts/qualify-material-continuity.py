#!/usr/bin/env python3
"""Verify interrupted motion, slot recovery and protected type with the native Metal program.

Usage: qualify-material-continuity.py NATIVE_BINARY MATERIAL_STUDIES_JSON NEW_EVIDENCE_DIR
The chart textures are frozen so pixel equality measures the material and source handoff.
"""
import argparse
import copy
import hashlib
import importlib.util
import json
import tempfile
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("studies", Path(__file__).with_name("qualify-authored-materials.py"))
studies = importlib.util.module_from_spec(spec)
spec.loader.exec_module(studies)


def prepare_design(path):
    design = json.loads(path.read_text())
    materials = design["materials"]
    by_id = {look["id"]: look for look in design["looks"]}
    # A shared set clock moves an animated path through a hard cut. The second look changes
    # a visible caption so matching phase cannot pass by silently retaining the first look.
    alternate = copy.deepcopy(by_id["path"])
    alternate["id"] = "handoff"
    next(l for l in alternate["layers"] if l["id"] == "duo-masthead")["content"]["value"] = "Handoff"
    design["looks"].append(alternate)
    materials["optical"]["motion"]["clock"] = "timeline"

    display = materials["display"]
    display["sources"].append("rtc-guest")
    objects = display["scene"]["objects"]
    # Keep the common back plate behind both independently angled screens.
    objects[0].update(scale=[1.79,.7,1], position=[0,0,-.28], rotation=[0,0,0])
    host = objects[1]
    host.update(scale=[.8, .6, 1], position=[-.85, 0, 0], rotation=[0, 8, 0])
    objects.append(dict(host, id="remote", input=1, position=[.85, 0, 0], rotation=[0, -8, 0]))
    # Flight's time-zero and the static resting look use exactly the same camera.
    for key in ["camera", "portraitCamera"]:
        display["scene"][key][1]["seconds"] = 1
        display["scene"][key][1]["eye"][0] += .9
    parked = copy.deepcopy(display)
    parked["clock"] = "live"
    for key in ["camera", "portraitCamera"]:
        origin = parked["scene"][key][0]
        parked["scene"][key] = [origin, dict(origin, seconds=1)]
    materials["parked"] = parked
    display["clock"] = "layout"
    design["looks"].append(dict(by_id["display"], id="parked", material="parked"))
    design["layoutTransitionMs"] = 1000
    design["reversibleLooks"] = {"display": "parked"}
    return design


def replay(binary, studio, scratch, start, cues):
    query, captures = scratch / (start + ".json"), scratch / start
    studies.save(query, {"set": "material-studies", "start": start, "cues": [
        dict({"host": True, "guest": True}, **c) for c in cues]})
    studies.success(studies.run(binary, studio, "--rehearse-layout-cues", query, captures))
    return captures, json.loads((captures / "trace.json").read_text())


def frame(captures, i, orientation):
    with Image.open(captures / f"{i:03}" / f"{orientation}.png") as image:
        return np.asarray(image.convert("RGB"))


def two(captures, i):
    return [frame(captures, i, o) for o in studies.VIEWS]


def same(a, b, label):
    mismatch = np.count_nonzero(np.any(a != b, axis=2))
    assert mismatch == 0, (label, mismatch)
    return 0


def contrast(im):
    return int(np.max(im.astype(int).mean(axis=2)) - np.min(im.astype(int).mean(axis=2)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("design", type=Path)
    parser.add_argument("out", type=Path)
    args = parser.parse_args()
    binary, out = args.binary.resolve(), args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    report = {"binarySha256": hashlib.sha256(binary.read_bytes()).hexdigest(), "measurements": {}}
    artwork = prepare_design(args.design)
    studies.save(out / "design.json", artwork)
    with tempfile.TemporaryDirectory() as temp:
        scratch = Path(temp)
        studio = scratch / "studio"
        studies.success(studies.run(binary, scratch, "--rehearse-authored-set", out/"design.json",
                                    scratch/"posters", studio))
        # Forward 0.35, reverse to 0.20, interrupt again and advance back to the same 0.35.
        flight, trace = replay(binary, studio, scratch, "parked", [
            {"at":0}, {"at":0,"layout":"display"}, {"at":.35},
            {"at":.35,"layout":"parked"}, {"at":.50}, {"at":.50,"layout":"display"},
            {"at":.65}, {"at":1.5}, {"at":1.5,"layout":"parked"}, {"at":2.5},
            {"at":2.5,"guest":False}, {"at":2.5,"host":False}, {"at":2.5}])
        studies.save(out/"reversible-trace.json",trace)
        studies.filmstrip(out, "reverse", [two(flight,i) for i in [0,2,4,6,7]])
        studies.filmstrip(out, "video-recovery", [two(flight,i) for i in [9,10,11,12]])
        assert all(len(t["slots"]) == 2 and {s["source"] for s in t["slots"]} ==
                   {"camera","rtc-guest"} and all(s["key"].startswith("graph/") for s in t["slots"])
                   and t["placesGuest"] for t in trace)
        compare = [(0,1),(2,3),(4,5),(2,6),(7,8),(0,9),(9,12)]
        for o in studies.VIEWS:
            values = report["measurements"][o] = {}
            vals = [same(frame(flight,i,o),frame(flight,j,o),(o,i,j)) for i,j in compare]
            assert studies.distance(frame(flight,2,o),frame(flight,4,o)) > .5
            assert studies.distance(frame(flight,0,o),frame(flight,7,o)) > 1
            values["transitionMismatchPixels"] = vals[:6]
            values["reversalVisibleMeanDelta"] = round(studies.distance(frame(flight,2,o),frame(flight,4,o)),3)
            base, host_only, guest_only = [frame(flight,i,o) for i in [9,10,11]]
            hostmask = np.any(base!=guest_only, axis=2)
            guestmask = np.any(base!=host_only, axis=2)
            assert hostmask.sum()>5000 and guestmask.sum()>5000 and not np.any(hostmask & guestmask)
            values["graphInputPixels"] = {"host":int(hostmask.sum()), "guest":int(guestmask.sum())}
            values["restoredFrameMismatchPixels"] = vals[6]
            values["protectedTypeMismatchPixels"] = {}
            crop = [.11,.102,.705,.055]
            plate = studies.region(base,crop)
            assert contrast(plate)>100
            for view in [host_only,guest_only,frame(flight,2,o),frame(flight,7,o)]:
                same(plate,studies.region(view,crop),("display type",o))
            values["protectedTypeMismatchPixels"]["dimensionalDisplay"] = 0

        # Set motion can be held while the live time and underlying transport advance. Frozen
        # test images ensure equal-time comparisons don't depend on the synthetic source clock.
        opt, trace = replay(binary,studio,scratch,"optical",[
            {"at":.3},{"at":.3,"playing":False},{"at":2.3},{"at":2.3,"playing":True},
            {"at":2.8},{"at":3., "layout":"perimeter"},{"at":3.4}])
        studies.save(out/"clock-trace.json",trace)
        for o in studies.VIEWS:
            base = frame(opt,0,o)
            for i in [1,2,3]:
                same(base,frame(opt,i,o),("held",i,o))
            assert studies.distance(base,frame(opt,4,o)) > .5
            for kind, a, b in [("refraction",0,4),("perimeter",5,6)]:
                before, after = frame(opt,a,o), frame(opt,b,o)
                assert studies.distance(before,after)>.05
                plate = studies.region(before,crop)
                assert contrast(plate)>100
                same(plate,studies.region(after,crop),(kind,o))
                report["measurements"][o]["protectedTypeMismatchPixels"][kind]=0
            report["measurements"][o]["heldMismatchPixels"]=0
            report["measurements"][o]["resumeMeanDeltaAfter500ms"] = round(studies.distance(base,frame(opt,4,o)),3)
        assert [round(t["setMotion"],3) for t in trace[:5]] == [.3,.3,.3,.3,.8]

        path, trace = replay(binary,studio,scratch,"path",[
            {"at":1.213},{"at":1.213,"layout":"handoff"},{"at":2.371},
            {"at":2.371,"layout":"path"},{"at":2.371,"guest":False},
            {"at":2.371,"host":False},{"at":2.371}])
        studies.save(out/"cut-trace.json",trace)
        for idx,o in enumerate(studies.VIEWS):
            r = report["measurements"][o]
            path_rect = [.4785,.48,.041,.04] if idx == 0 else [.48,.46,.04,.042]
            captions = ([.196875,.766,.23,.05] if idx == 0 else [.25,.791,.5,.031])
            for a,b in [(0,1),(2,3)]:
                before, after = frame(path,a,o), frame(path,b,o)
                assert studies.distance(before,after) > .005, ("cut failed",o,a)
                same(studies.region(before,path_rect),studies.region(after,path_rect),("cut phase",o))
            assert studies.distance(studies.region(frame(path,1,o),path_rect),
                                    studies.region(frame(path,2,o),path_rect)) > 1
            base = frame(path,3,o)
            same(base,frame(path,6,o),("path reconnect",o))
            slot_bounds = next(look["layers"] for look in artwork["looks"] if look["id"]=="path")
            role_frames = {l["id"]:l[["landscape","vertical"][idx]] for l in slot_bounds if l["id"].endswith("-window")}
            for n, missing, present in [(4,"guest-window","host-window"),(5,"host-window","guest-window")]:
                observed = frame(path,n,o)
                assert studies.distance(studies.region(base,role_frames[missing]),studies.region(observed,role_frames[missing]))>10
                same(studies.region(base,role_frames[present]),studies.region(observed,role_frames[present]),("surviving role",o,n))
            plate = studies.region(base,captions)
            assert contrast(plate)>60
            for n in [0,4,5,6]:
                same(plate,studies.region(frame(path,n,o),captions),("path type",o,n))
            r["protectedTypeMismatchPixels"]["emissivePath"]=0
            r["cutPathMismatchPixels"]=0
            r["recoveredDuoMismatchPixels"]=0
    studies.save(out/"measurements.json",report)
    studies.review(out,[
       ("Reversing the camera move","Start, 35%, reverse to 20%, forward to 35%, complete. Retaking a point on the same path reproduces both outputs byte for byte.","reverse"),
       ("Restoring a source","Host and guest, host only, guest only, both restored. Each generated video enters through its own geometry pass input.","video-recovery")])
    print(json.dumps(report,indent=2))


if __name__ == "__main__":
    main()
