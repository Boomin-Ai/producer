"""Correlate buffer receipt and subscriber callback observations on SFU wall time."""
import datetime
import hashlib
import json
from pathlib import Path

LAB = Path(__file__).resolve().parents[1]
runs = []
for variant in ["control", "candidate"]:
    log = LAB / f"runtime/delayed-{variant}-sfu.log"
    rows = []
    kinds = ["lab early audio sender report request", "lab buffer sender report received",
             "downtrack added", "lab publisher sender report"]
    for line in log.read_text().splitlines():
        for kind in kinds:
            if "\t" + kind + "\t" not in line:
                continue
            event = json.loads(line.split("\t" + kind + "\t", 1)[1])
            if kind != "lab publisher sender report" and event.get("mime") != "audio/opus":
                continue
            wall = event.get("lab_wall_us")
            if wall is None:
                stamp = datetime.datetime.strptime(line.split("\t")[0], "%Y-%m-%dT%H:%M:%S.%f%z")
                wall = round(stamp.timestamp() * 1e6)
            rows.append(dict(event, event=kind, wall_us=wall))
    tracks = {x["trackID"] for x in rows if x.get("participant") == "guest-1"
              and x["event"] == "lab buffer sender report received"}
    summary = []
    for track in sorted(tracks):
        events = [x for x in rows if x["trackID"] == track]
        def first(kind):
            return next((x for x in events if x["event"] == kind), None)
        receipt = first("lab buffer sender report received")
        request = first("lab early audio sender report request")
        added = first("downtrack added")
        forward = next((x for x in events if x["event"] == "lab publisher sender report"
                        and x.get("participant") == "native-host"), None)
        if not added or not forward:
            raise RuntimeError("Missing subscriber addition or forwarding trace: " + track)
        summary.append({"track_id": track,
                        "requests": sum(x["event"] == "lab early audio sender report request" for x in events),
                        "first_receipt_subscribers": receipt["lab_subscribers"],
                        "request_after_downtrack_ms": (request["wall_us"] - added["wall_us"]) / 1000 if request else None,
                        "first_receipt_after_downtrack_ms": (receipt["wall_us"] - added["wall_us"]) / 1000,
                        "first_forward_after_receipt_ms": (forward["wall_us"] - receipt["wall_us"]) / 1000})
    if len(summary) != 2:
        raise RuntimeError("Expected two audio publications for one guest with one rejoin")
    for track in summary:
        expected_requests = 1 if variant == "candidate" else 0
        if track["requests"] != expected_requests or track["first_receipt_subscribers"] < 1:
            raise RuntimeError("Request budget or subscriber receipt assumption failed")
        if variant == "candidate" and track["request_after_downtrack_ms"] <= 0:
            raise RuntimeError("Candidate requested before subscriber initialization")
    runs.append({"variant": variant, "trace_sha256": hashlib.sha256(log.read_bytes()).hexdigest(),
                 "guest_audio_tracks": summary})
output = {"runs": runs,
          "clock_domain": "All deltas use SFU wall time; receipt is callback observation, not packet wire arrival. Downtrack log has millisecond precision.",
          "g1_complete": False}
(LAB / "evidence/delayed-request-subscription-order.json").write_text(json.dumps(output, indent=2) + "\n")
print(json.dumps(output, indent=2))
