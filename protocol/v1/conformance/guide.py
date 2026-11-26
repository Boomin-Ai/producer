"""Refresh the offline guide with samples from the native show engine."""
import argparse
import base64
from fractions import Fraction
import json
from pathlib import Path
import subprocess

V1 = Path(__file__).resolve().parents[1]


def generate(core):
    path = V1 / "listening-room"
    document = json.loads((path / "production.json").read_bytes())
    manifest = json.loads((path / "manifest.json").read_bytes())
    show = manifest["entry"]["show"]
    set_id = document["shows"][show]["set"]
    video = (path / "blobs" / document["assets"]["slate"]["hash"]).read_bytes()
    frames = []
    for i in range(0, 601, 40):
        events = [{"kind":"start","at":"0"}]
        for tick in range(i, min(i + 40, 601)):
            events.append({"kind":"seek","at":"0","to":{"ticks":str(tick),"rate":100}})
        command = [core,"bundle-show",str(path),show,json.dumps(events)]
        samples = json.loads(subprocess.check_output(command))["samples"][1:]
        for s in samples:
            active = {p["source"]: p for p in s["timeline"]["players"] if p.get("controls")}
            picture = active.get("picture", {})
            t = picture.get("sourceTime")
            frames.append({"segment":s["segment"],"layout":s["landscape"],"v":s["vertical"],"g":s["landscapeGraph"],"vg":s["verticalGraph"],
                           "gain":active.get("keys",{}).get("controls",{}).get("gain"),"source":float(Fraction(int(t["ticks"]),t["rate"])) if t else None,
                           "saturation":picture.get("controls",{}).get("saturation")})
    return {"show":show,"set":set_id,"graphs":document["sets"][set_id]["graphs"],"session":manifest["musicSessions"]["score"],
            "video":"data:video/mp4;base64,"+base64.b64encode(video).decode(),"frames":frames}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--core",required=True)
    args = parser.parse_args()
    page = V1 / "index.html"
    head, rest = page.read_text().split('<script id="data" type="application/json">',1)
    _, tail = rest.split("</script>",1)
    data = json.dumps(generate(args.core),separators=(",",":")).replace("<","\\u003c")
    page.write_text(head+'<script id="data" type="application/json">'+data+"</script>"+tail)
