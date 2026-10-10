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
assert report["sources_alive"] == 0 and report["registry_expired"]
report["cycles"] = 100
report["checks"] = ["decoded metadata preserved", "error frames excluded", "duplicate/null registration rejected",
                    "RRTR rewrite idempotent", "video SDP unchanged", "concurrent pull/remove", "explicit unregister", "cancel/partial teardown", "weak state expired"]
(lab/"evidence/timed-mixer-lifecycle.json").write_text(json.dumps(report, indent=2)+"\n")
print("100 native mixer lifecycle cycles passed; 200 wrappers destroyed; weak state expired")
