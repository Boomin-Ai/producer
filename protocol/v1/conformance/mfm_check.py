"""Exercise the bundled My First Million rundown through Producer's headless show engine."""
import argparse
import json
from pathlib import Path
import subprocess
import sys

V1 = Path(__file__).resolve().parents[1]
BUNDLE = V1 / "my-first-million"


def check(core):
    subprocess.run([sys.executable, V1 / "snapshot.py", "--core", core, "verify", BUNDLE,
                    "--trust", V1 / "conformance/show-signers"], check=True, stdout=subprocess.DEVNULL)
    events = [{"kind": "start", "at": "0"}]
    for second in [4, 8]:
        events.append({"kind": "advance", "at": str(second * 10**9)})
    events.append({"kind": "seek", "at": "8000000000", "to": {"ticks": "3", "rate": 1}})
    for second in [9, 10, 11, 12]:
        events.append({"kind": "next", "at": str(second * 10**9)})
    samples = json.loads(subprocess.check_output([
        core, "bundle-show", BUNDLE, "my-first-million", json.dumps(events)
    ]))["samples"]
    assert [s["segment"] for s in samples] == [
        "opening", "opening", "opening", "opening", "conversation", "guest-interview", "breakdown", "takeaway"
    ]
    assert len({s["occurrence"] for s in samples[:4]}) == 1
    assert len({s["occurrence"] for s in samples}) == 5
    pairs = [(s["landscape"], s["vertical"]) for s in samples]
    assert pairs == [(prefix + "landscape", prefix + "vertical") for prefix in [
        "opening-", "focus-shaan-", "focus-sam-", "opening-", "", "interview-", "screen-share-", "follow-"
    ]]
    assert all(s["landscapeGraph"] == s["verticalGraph"] == "stage" for s in samples)
    assert [[c["cue"] for c in s["timeline"]["cues"]] for s in samples[:3]] == [
        ["opening-in"], ["focus-shaan"], ["focus-sam"]
    ]
    for sample, source in [(samples[5], "rtc-guest"), (samples[6], "screen")]:
        assert any(p["source"] == source and p["live"] for p in sample["timeline"]["players"])
    print("Verified signed My First Million show: five segments, dual outputs, two timed host cuts, reverse seek, guest and screen.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--core", required=True)
    check(parser.parse_args().core)
