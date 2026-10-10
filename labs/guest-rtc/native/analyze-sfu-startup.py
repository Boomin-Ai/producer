"""Compare the two isolated cadence runs without mixing wall and receiver clocks."""
import hashlib
import json
from pathlib import Path

LAB = Path(__file__).resolve().parents[1]
results = []
for cadence in ("baseline", "fast"):
    path = LAB / f"evidence/transport-obs-audio-master-cadence-{cadence}-rejoin.json"
    log = LAB / f"runtime/cadence-{cadence}-sfu.log"
    report = json.loads(path.read_text())
    publishers = {}
    for line in log.read_text().splitlines():
        if "\tlab publisher sender report\t" not in line:
            continue
        event = json.loads(line.split("\tlab publisher sender report\t", 1)[1])
        if event["participant"] != "native-host":
            continue
        publishers.setdefault(event["lab_downstream_ssrc"], []).append(event)
    epochs = {}
    for point in report["audio_master_playback"]["startup_milestones"]:
        epoch = epochs.setdefault(point["binding_since_us"], {"binding_since_us": point["binding_since_us"]})
        epoch[point["milestone"] + "_ms"] = point["since_binding_us"] / 1000
        if "sender_ntp_us" not in point:
            continue
        candidates = publishers.get(point["ssrc"], [])
        track_ids = {entry["trackID"] for entry in candidates}
        if not candidates or len(track_ids) != 1:
            raise RuntimeError("Missing or ambiguous publisher trace for native SSRC")
        first = candidates[0]
        fixed = first["lab_publisher_ntp"]
        publisher_ntp_us = (fixed >> 32) * 1_000_000 + ((fixed & 0xffffffff) * 1_000_000 >> 32)
        epoch[point["milestone"] + "_origin_trace"] = {
            "ssrc": point["ssrc"], "publisher_track_id": first["trackID"],
            "publisher_reports_seen_at_sfu": len(candidates),
            "first_publisher_report_sfu_wall_us": first["lab_wall_us"],
            "first_publisher_ntp_us": publisher_ntp_us,
            "first_received_report_ntp_us": point["sender_ntp_us"],
            "sender_ntp_advance_ms": (point["sender_ntp_us"] - publisher_ntp_us) / 1000,
        }
    for epoch in epochs.values():
        audio = epoch.get("first_incoming_audio_report_origin_trace")
        video = epoch.get("first_incoming_video_report_origin_trace")
        if audio and video:
            epoch["sfu_first_audio_minus_video_publisher_report_ms"] = (
                audio["first_publisher_report_sfu_wall_us"] -
                video["first_publisher_report_sfu_wall_us"]) / 1000
    playback = report["audio_master_playback"]
    mixer = report["timed_mixer_probe"]
    results.append({
        "cadence": cadence, "cadence_ms": 3000 if cadence == "baseline" else 250,
        "native_report_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "sfu_trace_sha256": hashlib.sha256(log.read_bytes()).hexdigest(),
        "epochs": list(epochs.values()), "audio_startup_dropped_blocks": playback["clock"]["audio_startup_dropped"],
        "discovery_after_shutdown": playback["binding_discovery_after_shutdown"],
        "decoded_sources_created": mixer["sources_created"],
        "decoded_sources_destroyed": mixer["sources_destroyed"],
        "decoded_sources_alive": mixer["sources_alive"],
    })
output = {
    "runs": results,
    "clock_domains": "Epoch intervals use receiver monotonic time only. NTP advance uses sender origin only; it is not isolated network latency or an exact SFU hold measurement.",
    "limits": "Sequential synthetic local runs, not an identical captured-input replay. Increased RTCP traffic; no Cloud, physical AEC or production qualification.",
    "g1_complete": False,
}
(LAB / "evidence/sfu-cadence-startup-comparison.json").write_text(json.dumps(output, indent=2) + "\n")
print(json.dumps(output, indent=2))
