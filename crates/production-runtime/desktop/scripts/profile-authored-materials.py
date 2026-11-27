#!/usr/bin/env python3
"""Compare deterministic frames with and without profiling; record Metal per-pass measurements.

Usage: profile-authored-materials.py NATIVE_BINARY DESIGN_JSON NEW_EVIDENCE_DIRECTORY
"""
import argparse
import hashlib
import json
import os
import statistics
import subprocess
import tempfile
from pathlib import Path


def run(binary, root, *args):
    subprocess.run([binary, *args], check=True, stdout=subprocess.DEVNULL,
                   env=dict(os.environ, PRODUCER_NATIVE_ROOM_HOME=str(root)))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for arg in ["binary", "design", "output"]:
        p.add_argument(arg, type=Path)
    args = p.parse_args()
    binary, design_path, dest = (a.resolve() for a in (args.binary, args.design, args.output))
    design = json.loads(design_path.read_text())
    dest.mkdir(parents=True)
    report = {"binarySha256": hashlib.sha256(binary.read_bytes()).hexdigest(), "layouts": {}}
    with tempfile.TemporaryDirectory() as temp:
        tmp = Path(temp)
        studio, pics, q = tmp/"private-studio", tmp/"capture", tmp/"query.json"
        run(binary,tmp,"--rehearse-authored-set",design_path,tmp/"posters",studio)
        for look in design["looks"]:
            baseline = {}
            records = []
            for i in range(6):
                q.write_text(json.dumps(dict(set=design["id"],layout=look["id"],time=2.,profileGpu=(i>0))))
                run(binary,studio,"--inspect-set-picture",q,pics)
                observed = {name:hashlib.sha256((pics/(name+".png")).read_bytes()).hexdigest()
                            for name in ["landscape","portrait"]}
                receipt = json.loads((pics/"receipt.json").read_text())
                if i==0:
                    baseline=observed
                    assert "gpuTiming" not in receipt
                else:
                    assert baseline==observed, (look["id"], "profiled frame changed")
                    records.append(receipt["gpuTiming"])
            summary = {}
            for view in baseline:
                stats = [r[view] for r in records]
                assert all(s["commandBufferMs"]>0 for s in stats)
                for s in stats:
                    if s["measurement"]=="metalStageTimestamps":
                        assert s["missingEncoderSamples"]==0
                        for row in s["renderEncoders"]:
                            assert row["stageEnvelopeMs"] <= s["commandBufferMs"]*1.05+.10, (row,s)
                            assert row["pass"] and row["stageEnvelopeMs"] >= max(row["vertexMs"],row["fragmentMs"]) - 1e-8
                encoder_names = sorted({p["pass"] for s in stats for p in s.get("renderEncoders",[])})
                summary[view] = {
                    "method":stats[0]["measurement"], "device":stats[0]["device"],
                    "commandBufferMedianMs":round(statistics.median(s["commandBufferMs"] for s in stats),3),
                    "encoderMedianMs":{name:round(statistics.median(row["stageEnvelopeMs"] for s in stats
                                for row in s.get("renderEncoders",[]) if row["pass"]==name),3)
                                for name in encoder_names}}
            report["layouts"][look["id"]] = {"pngSha256":baseline,"samples":records,"summary":summary}
    (dest/"measurements.json").write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps({k:v["summary"] for k,v in report["layouts"].items()},indent=2))


if __name__=="__main__":
    main()
