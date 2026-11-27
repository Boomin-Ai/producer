#!/usr/bin/env python3
"""Run the private Metal renderer on editable materials and a separate Signal Room studio.

Usage: qualify-authored-materials.py NEW_ROOM_BINARY SIGNAL_ROOM_AUTHORSET_JSON NEW_EVIDENCE_DIR
Requires Pillow and NumPy. No account, webcam or running studio is accessed.
"""
import argparse
import hashlib
import html
import json
import os
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

VIEWS = ("landscape", "portrait")
MOTION = {"periodSeconds": 4, "phaseTurns": 0}
FULL = [0, 0, 1, 1]


def layer(name, content, landscape=FULL, vertical=FULL, **props):
    return dict(id=name, content=content, landscape=landscape, vertical=vertical, **props)


def fill(color):
    return {"fill": {"kind": "solid", "ink": {"color": color, "opacity": 1}}}


def label(text):
    return layer("type", {"kind": "text", "value": text, "font": "0" * 64},
                 [.12, .106, .74, .048], [.12, .106, .74, .048],
                 style={"text": {"fontSize": 28, "weight": 700, "align": "left",
                                 "ink": {"color": "#FFF7D6", "opacity": 1}}})


def moving_display():
    def camera(eye, fov, seconds):
        return {"eye": eye, "target": [0, 0, 0], "fov": fov, "seconds": seconds}

    mesh = dict(mesh="panel", scale=[1.5, .85, 1], rotation=[-5, -18, 2],
                roughness=.2, metallic=.5, color=[.09, .1, .23])
    return {
        "sources": ["camera"], "kind": "dimensionalDisplay", "clock": "live",
        "scene": {
            "camera": [camera([0, 0, 4.15], 44, 0), camera([.52, .18, 4.35], 44, 4)],
            "portraitCamera": [camera([0, 0, 5.8], 61, 0), camera([.4, .18, 5.85], 61, 4)],
            "lightDirection": [.3, .72, .64], "lightColor": [1.3, 1.1, .85],
            "ambient": [.2, .25, .3],
            "objects": [dict(mesh, id="bezel", position=[0, 0, -.075], scale=[1.59, .94, 1]),
                        dict(mesh, id="image", position=[0, 0, 0], input=0)]}}


def swatches(signal):
    duo = next(look for look in signal["looks"] if look["id"] == "duo")
    camera = layer("picture", {"kind": "source", "source": "camera", "fit": "cover"},
                   [.1, .085, .8, .83], [.1, .085, .8, .83])
    ground = layer("ground", {"kind": "group"}, style=fill("#10131A"))
    plaque = layer("plaque", {"kind": "group"}, [.105, .10, .72, .065], [.105, .10, .72, .065],
                   style=fill("#1E2731"))
    looks = [dict(duo, id="path")]
    for look in ("perimeter", "optical"):
        looks.append(dict(id=look, material=look, layers=[ground, camera, plaque, label(look.upper())]))
    looks.append(dict(id="display", material="display", layers=[plaque, label("DISPLAY")]))
    return {
        "op": "authorSet", "id": "material-studies", "looks": looks,
        "materials": dict(signal["materials"],
                          perimeter=dict(kind="perimeter", layer="picture", widthPx=13,
                                         color="#A12DFF", highlight="#FF9233", motion=MOTION),
                          optical=dict(kind="refraction", layer="picture", displacementPx=25,
                                       wavelengthPx=140, motion=MOTION), display=moving_display())}


def upgrade_signal(source):
    design = json.loads(source.read_text())
    design["id"] = "signal-room"
    duo = next(look for look in design["looks"] if look["id"] == "duo")
    duo["layers"] = [l for l in duo["layers"] if l["id"] != "channel-track"]
    for item in duo["layers"]:
        if item["id"] == "host-window":
            item["attachments"] = {"exit": {"landscape": [1, .5], "vertical": [.5, 1]}}
        if item["id"] == "guest-window":
            item["attachments"] = {"entry": {"landscape": [0, .5], "vertical": [.5, 0]}}
    design["materials"][duo["material"]] = {
        "kind": "emissivePath", "from": {"layer": "host-window", "anchor": "exit"},
        "to": {"layer": "guest-window", "anchor": "entry"}, "widthPx": 3.5,
        "color": "#27469E", "highlight": "#FFEAC3", "motion": MOTION}
    return design


def save(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def run(bin_path, root, *args, **opts):
    return subprocess.run([str(bin_path), *map(str, args)],
                          env=dict(os.environ, PRODUCER_NATIVE_ROOM_HOME=str(root)),
                          text=True, capture_output=True, **opts)


def success(proc):
    if proc.returncode:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip())
    return proc


def render(binary, root, scratch, layout, time, change=None, disconnected=False, tap=None):
    query = dict(set="material-studies", layout=layout, time=time, disconnected=disconnected)
    if change:
        query["candidate"] = dict(op="editAuthoredSet", id="material-studies", changes=change)
    if tap:
        query["pass"] = tap
    save(scratch / "query.json", query)
    path = scratch / "capture"
    success(run(binary, root, "--inspect-set-picture", scratch / "query.json", path))
    with Image.open(path / "landscape.png") as land, Image.open(path / "portrait.png") as port:
        return [np.asarray(im.convert("RGB")) for im in (land, port)]


def region(img, bounds):
    x, y, w, h = bounds
    height, width = img.shape[:2]
    return img[round(y * height):round((y+h)*height), round(x*width):round((x+w)*width)]


def distance(a, b):
    return np.abs(a.astype(np.int16) - b.astype(np.int16)).mean()


def path_peak(image, portrait, y_end=.503125):
    h, w = image.shape[:2]
    x1, y1, x2, y2 = (.5, .459375, .5, y_end) if portrait else (.478125, .5, .521875, .5)
    t = np.linspace(0, 1, 100)
    profile = image[(h * (y1 + t*(y2-y1))).astype(int), (w * (x1 + t*(x2-x1))).astype(int)]
    # The two video slots meet the endpoints, so test only the interior.
    return t[5 + np.argmax(profile[5:95].astype(float).sum(axis=1))]


def filmstrip(directory, name, frames):
    previews = []
    for frame in frames:
        wide = Image.fromarray(frame[0])
        tall = Image.fromarray(frame[1])
        wide.thumbnail((400, 225), Image.Resampling.LANCZOS)
        tall.thumbnail((127, 225), Image.Resampling.LANCZOS)
        both = Image.new("RGB", (wide.width + 6 + tall.width, 225), "#12171E")
        both.paste(wide, (0, 0))
        both.paste(tall, (wide.width + 6, 0))
        previews.append(both)
    film = Image.new("RGB", (previews[0].width, 225 * len(previews) + 8*(len(previews)-1)), "#12171E")
    for i, pair in enumerate(previews):
        film.paste(pair, (0, i*233))
    film.save(directory/f"{name}.jpg", quality=92, subsampling=0)


def review(out, rows):
    def section(title, summary, image):
        return f'<section><h2>{html.escape(title)}</h2><p>{html.escape(summary)}</p><img alt="{html.escape(title)} native landscape and portrait filmstrip" src="{image}.jpg"></section>'
    out.joinpath("index.html").write_text('''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Native Material Studies</title><style>*{box-sizing:border-box}body{margin:0 auto;max-width:1200px;padding:clamp(24px,6vw,80px);background:#13171d;color:#f3ebda;font:16px/1.5 system-ui}h1{font-size:clamp(32px,6vw,74px);letter-spacing:-.045em;line-height:1.05;margin:.4em 0}p{color:#b6c5d5;max-width:72ch}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(360px,100%),1fr));gap:32px}h2{margin:24px 0 4px}section{border-top:1px solid #526274}img{width:100%;height:auto}</style><h1>Native material studies</h1><p>Each row is one frozen time on the Metal program path. Landscape and portrait share the same time. Generated blue and amber video charts make changes in crop, motion and refraction visible.</p><main>''' + ''.join(section(*row) for row in rows) + '</main></html>')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bin", type=Path)
    parser.add_argument("signal_source", type=Path)
    parser.add_argument("evidence", type=Path)
    args = parser.parse_args()
    binary = args.bin.resolve()
    out = args.evidence.resolve()
    out.mkdir(parents=True)  # Never overwrite a studio or prior evidence.
    signal = upgrade_signal(args.signal_source)
    studies = swatches(signal)
    save(out/"signal-room.design.json", signal)
    save(out/"material-studies.design.json", studies)
    report = {"binarySha256": hashlib.sha256(binary.read_bytes()).hexdigest(), "measurements": {}}
    with tempfile.TemporaryDirectory() as temp:
        scratch = Path(temp)
        root = scratch/"studio"
        success(run(binary, scratch, "--rehearse-authored-set", out/"material-studies.design.json",
                    out/"posters", root))
        success(run(binary, scratch, "--rehearse-authored-set", out/"signal-room.design.json",
                    out/"signal-posters", out/"Signal Room Dev"))
        # The second process reloads the exact versioned design from disk for every edit.
        frames = {}
        for look in ("path","perimeter","optical","display"):
            seq = [render(binary, root, scratch, look, t) for t in (1., 2., 3.)]
            again = render(binary, root, scratch, look, 1.)
            assert all(np.array_equal(x,y) for x,y in zip(seq[0],again)), f"nondeterministic {look}"
            filmstrip(out,look,seq)
            frames[look] = seq
        for index, orientation in enumerate(VIEWS):
            peaks = [round(float(path_peak(pair[index], bool(index))), 3) for pair in frames["path"]]
            assert np.max(np.abs(np.array(peaks)-[.25,.5,.75])) < .055, (orientation, peaks)
            report["measurements"][orientation] = {"pathPeakFractions":peaks, "deterministic":True}
        edit = [{"op":"frame","look":"path","layer":"guest-window","vertical":[.25,.57,.5,.28125]},
                {"op":"materialParam","material":"signal-channel","param":"motion.periodSeconds","value":8}]
        edited = render(binary,root,scratch,"path",2,edit)
        for i, orientation in enumerate(VIEWS):
            assert abs(path_peak(edited[i],bool(i),.57)-.25)<.055
            report["measurements"][orientation]["editedPathPeakAt2s"]=round(float(path_peak(edited[i],bool(i),.57)),3)
        before = frames["path"][1]
        moved = render(binary,root,scratch,"path",2,edit[:1])
        assert np.array_equal(moved[0],before[0]) and not np.array_equal(moved[1],before[1])
        filmstrip(out,"attachment-edit",[before,moved])
        invalid = [{"op":"materialParam","material":"signal-channel","param":"to.anchor","value":"absent"}]
        save(scratch/"invalid.json",dict(set="material-studies",layout="path",candidate=dict(
            op="editAuthoredSet",id="material-studies",changes=invalid)))
        rejected = run(binary,root,"--inspect-set-picture",scratch/"invalid.json",scratch/"invalid-output")
        assert rejected.returncode and "guest-window.absent" in rejected.stderr, rejected.stderr
        no_warp = render(binary,root,scratch,"optical",2,[dict(op="materialParam",material="optical",
                         param="displacementPx",value=0)])
        unlit = render(binary,root,scratch,"display",2,disconnected=True)
        display_pass = render(binary,root,scratch,"display",2,tap="display")
        for i, orientation in enumerate(VIEWS):
            actual = frames["optical"][1][i]
            assert np.array_equal(region(actual,[.11,.102,.705,.055]),region(no_warp[i],[.11,.102,.705,.055]))
            warp_diff = distance(region(actual,[.16,.25,.68,.47]),region(no_warp[i],[.16,.25,.68,.47]))
            assert warp_diff>1, (orientation,warp_diff)
            display_diff=distance(frames["display"][1][i],unlit[i])
            assert display_diff>1, (orientation,display_diff)
            assert distance(region(display_pass[i],[.11,.102,.705,.055]),region(frames["display"][1][i],[.11,.102,.705,.055]))>1
            report["measurements"][orientation].update(opticalPictureMeanDelta=round(warp_diff,3),
                protectedCaptionDelta=0,displayConnectedMeanDelta=round(display_diff,3))
        filmstrip(out,"optical-edit",[no_warp,frames["optical"][1]])
    report.update(portraitOnlyEditPreservedLandscape=True, rejectedAnchor="guest-window.absent")
    save(out/"measurements.json",report)
    review(out,[
        ("Traveling light","Peak at one, two and three seconds in a four-second cycle.","path"),
        ("Perimeter","A colored ridge travels along the camera opening.","perimeter"),
        ("Refraction","A traveling height gradient bends the video grid. The caption sits above it.","optical"),
        ("Dimensional display","Native camera changes perspective on a depth-tested, video-textured panel and its bezel.","display"),
        ("Moving an attachment","Moving the guest lower lengthens the portrait connection. Landscape is byte-identical.","attachment-edit"),
        ("Turning up refraction","Equal-time control and 25-pixel displacement. The opaque caption is byte-identical.","optical-edit")])
    print(json.dumps(report,indent=2))


if __name__ == "__main__":
    main()
