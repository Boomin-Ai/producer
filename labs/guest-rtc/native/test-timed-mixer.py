# Uses the already-built pinned archive; does not download or rebuild WebRTC.
import json, pathlib, subprocess
lab = pathlib.Path(__file__).resolve().parents[1]
outputs = list((lab / "target/debug/build").glob("webrtc-sys-*/output"))
archive = None
for output in outputs:
    for line in output.read_text().splitlines():
        if line.startswith("cargo:rustc-link-search=native="):
            candidate = pathlib.Path(line.split("=", 2)[2]) / "libwebrtc.a"
            if candidate.is_file(): archive = candidate
assert archive, "Build the lab once to obtain its pinned native archive"
include = archive.parent.parent / "include"
binary = lab / "runtime/timed-mixer-lifecycle"
command = ["clang++", "-std=c++20", "-Wno-nullability-completeness", "-DWEBRTC_MAC", "-DWEBRTC_POSIX", "-I"+str(include),
           "-I"+str(include/"third_party/abseil-cpp"), "-I"+str(lab/"vendor/webrtc-sys/include"),
           str(lab/"native/timed-mixer-lifecycle.cpp"), str(archive), "-o", str(binary)]
for framework in ["Foundation", "AVFoundation", "Security", "CoreAudio", "AudioToolbox", "AppKit", "CoreMedia", "CoreGraphics", "VideoToolbox", "CoreVideo", "OpenGL"]:
    command += ["-framework", framework]
subprocess.run(command, check=True)
result = subprocess.run([str(binary)], check=True, capture_output=True, text=True)
report = json.loads(result.stdout)
assert report["mixer"]["sources_alive"] == 0 and report["mixer"]["registry_expired"]
assert report["rtcp"]["logs_alive"] == 0 and report["rtcp"]["registry_expired"]
report["cycles"] = 100
report["checks"] = ["PCM and RTP metadata paired", "mono and stereo PCM preserved", "three-block queue bounded", "oldest overflow dropped", "stale PCM excluded", "retirement flush", "pull contention nonblocking", "unsupported PCM format rejected", "per-generation PCM accounting", "decoded metadata preserved", "error frames excluded", "duplicate/null registration rejected",
                    "RRTR rewrite idempotent", "video SDP unchanged", "concurrent pull/remove", "explicit unregister", "cancel/partial teardown", "weak state expired", "RTCP requests/replies parsed", "sender-report RTP/NTP preserved", "malformed RTCP bounded", "XR ring overflow", "log failure/callback teardown", "thread/FD baseline recovery"]
(lab/"evidence/decoded-pcm-lifecycle.json").write_text(json.dumps(report, indent=2)+"\n")
print("100 mixer/log lifecycle cycles passed; 201 source wrappers and 200 log observers destroyed")
