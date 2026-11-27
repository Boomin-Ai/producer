#!/usr/bin/env python3
"""Render a paired review movie from a saved studio, with deterministic source pictures."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("producer", type=Path, help="Producer Dev executable")
    parser.add_argument("studio", type=Path)
    parser.add_argument("set_id")
    parser.add_argument("destination", type=Path, help="New .mp4 file")
    parser.add_argument("layouts", nargs=3, help="Three layout names in playback order")
    parser.add_argument("--candidate", type=Path, help="Render a private design or revision in this studio")
    parser.add_argument("--pictures", nargs=2, type=Path, metavar=("HOST", "GUEST"),
                        help="Local still images to feed into the native camera and guest slots")
    args = parser.parse_args()
    producer = args.producer.resolve(strict=True)
    destination = args.destination.resolve()
    if destination.exists() or destination.suffix.lower() != ".mp4":
        parser.error("Choose a new .mp4 file")
    # The three cuts share one native motion clock. Fixed source images isolate
    # the motion that the authored materials and transitions contribute.
    fps = 15
    frames_per_look = 40
    cues = []
    for layout in args.layouts:
        for frame in range(frames_per_look):
            cue = {"at": len(cues) / fps, "host": True, "guest": True}
            if frame == 0:
                cue["layout"] = layout
            cues.append(cue)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=destination.parent) as scratch:
        scratch = Path(scratch)
        cues_file = scratch / "cues.json"
        sequence = {"set": args.set_id, "start": args.layouts[0], "cues": cues}
        if args.pictures:
            sequence["samplePictures"] = [str(path.resolve(strict=True)) for path in args.pictures]
        cues_file.write_text(json.dumps(sequence))
        frames = scratch / "frames"
        command = [producer, "--rehearse-layout-cues", cues_file, frames]
        if args.candidate:
            command.extend(["--candidate", args.candidate.resolve(strict=True)])
        subprocess.run(command,
                       env=dict(os.environ, PRODUCER_NATIVE_ROOM_HOME=str(args.studio.resolve())),
                       check=True)
        trace = json.loads((frames / "trace.json").read_text())
        if len(trace) != len(cues):
            raise RuntimeError("Incomplete native capture")
        paired = scratch / "paired.mp4"
        subprocess.run([producer.with_name("ffmpeg"), "-nostdin", "-loglevel", "error",
                        "-framerate", str(fps), "-i", frames / "%03d/landscape.png",
                        "-framerate", str(fps), "-i", frames / "%03d/portrait.png",
                        "-filter_complex", "[0:v]scale=-2:480,setsar=1[l];"
                        "[1:v]scale=-2:480,setsar=1[p];[l][p]hstack,format=yuv420p",
                        "-frames:v", str(len(cues)), "-an", "-c:v", "libx264", "-threads", "2",
                        "-preset", "veryfast", "-crf", "18", "-movflags", "+faststart", paired],
                       check=True)
        # A simultaneous reviewer cannot overwrite a movie another run just published.
        os.link(paired, destination)


if __name__ == "__main__":
    main()
