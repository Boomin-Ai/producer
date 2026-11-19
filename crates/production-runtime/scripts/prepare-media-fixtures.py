#!/usr/bin/env python3
"""Synthetic, redistributable local MOV fixtures; no device or user-media access."""
import hashlib
import json
import math
from pathlib import Path
import struct
import subprocess

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "target/native-media-fixtures"
SDK = ROOT / "target/native-media-sdk/install/bin"
OUT.mkdir(parents=True, exist_ok=True)
rgb = bytearray()
for frame in range(24):
    for y in range(48):
        for x in range(64):
            rgb.extend(((frame * 9 + x) % 256, (frame * 17 + y) % 256, (x * 3 + y * 5) % 256))
(OUT / "video.rgb").write_bytes(rgb)
(OUT / "tone.pcm").write_bytes(b"".join(struct.pack("<h", round(8000 * math.sin(2 * math.pi * 440 * n / 48000))) for n in range(48000 * 4)))
manifest = {}
for name, args in {
    "cfr": ["-c:v", "rawvideo", "-pix_fmt", "rgb24"],
    "bframes": ["-c:v", "mpeg4", "-q:v", "2", "-bf", "2", "-g", "6", "-pix_fmt", "yuv420p"],
    "vfr": ["-vf", "setpts=if(lt(N\\,12)\\,N/(12*TB)\\,(12+2*(N-12))/(12*TB))", "-fps_mode", "passthrough", "-c:v", "mpeg4", "-q:v", "2", "-bf", "0", "-g", "6", "-pix_fmt", "yuv420p"],
    "hd1080": ["-vf", "scale=1920:1080", "-c:v", "mpeg4", "-q:v", "2", "-bf", "2", "-g", "6", "-pix_fmt", "yuv420p"],
}.items():
    path = OUT / f"{name}.mov"
    subprocess.run([str(SDK / "ffmpeg"), "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", "64x48", "-framerate", "12", "-i", str(OUT / "video.rgb"), "-f", "s16le", "-ar", "48000", "-ac", "1", "-i", str(OUT / "tone.pcm"), *args, "-c:a", "pcm_s16le", "-t", "3", str(path)], check=True)
    info = json.loads(subprocess.check_output([str(SDK / "ffprobe"), "-v", "error", "-select_streams", "v:0", "-show_frames", "-show_streams", "-of", "json", str(path)]))
    width, height = info["streams"][0]["width"], info["streams"][0]["height"]
    frames = []
    with subprocess.Popen([str(SDK / "ffmpeg"), "-v", "error", "-threads", "1", "-i", str(path), "-an", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], stdout=subprocess.PIPE) as process:
        for f in info["frames"]:
            image = process.stdout.read(width*height*4)
            assert len(image) == width*height*4
            frames.append({"pts": f["best_effort_timestamp"], "duration": f["duration"], "sha256": hashlib.sha256(image).hexdigest()})
        assert process.stdout.read(1) == b""
        assert process.wait() == 0
    assert len(frames) == 24
    pcm = subprocess.check_output([str(SDK / "ffmpeg"), "-v", "error", "-i", str(path), "-vn", "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"])
    manifest[name] = {"fileSha256": hashlib.sha256(path.read_bytes()).hexdigest(), "timeBase": info["streams"][0]["time_base"], "width":width,"height":height,"audioSamples":len(pcm)//2,"audioSha256":hashlib.sha256(pcm).hexdigest(),"frames": frames}
(OUT / "reference.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(json.dumps({"fixtures": list(manifest), "framesEach": 24, "folder": str(OUT)}))
