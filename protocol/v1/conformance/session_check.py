"""Exercise a signed show and an independent headless DAW against the same picture clock."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import wave
from xml.etree import ElementTree as ET
from zipfile import ZipFile
from check import call, read, write, HERE, V1


def inspect_score(path):
    with ZipFile(path) as f:
        xml = ET.fromstring(f.read("project.xml"))
    notes = [n.attrib for n in xml.findall(".//Note")]
    return (xml.find("./Transport/Tempo").get("value"), xml.find(".//BuiltinDevice").get("deviceID"),
            notes, xml.find(".//Marker").attrib)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(core):
    src = V1 / "listening-room"
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        trust = root / "signers"
        key = root / "editor"
        call("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key)
        trust.write_text((HERE / "session-signers").read_text() + 'editor@fork.example namespaces="producer.bundle.v1" ' + key.with_suffix(".pub").read_text())
        snap = [sys.executable, V1 / "snapshot.py", "--core", core]
        adapter = [sys.executable, V1 / "adapters/daw.py", "--core", core]
        handoff, draft, child, reopened = [root / s for s in ("handoff", "draft", "child", "reopened")]
        base = call(*snap, "verify", src, "--trust", trust)
        observations = root / "inputs.json"
        for who, audio, video, expected in [("robin", True, False, True), ("robin", False, True, False), ("other", True, True, False)]:
            write(observations, {"guest": {"actor": who, "audio": audio, "video": video}})
            assert call(core, "bundle-readiness", src, "desk", "live-wide", observations)["ready"] == expected
        assert call(core, "bundle-readiness", src, "desk", "wide", observations)["ready"]
        call(*adapter, "export", src, "score", handoff, "--trust", trust)
        old = inspect_score(handoff / "score.dawproject")
        old_pcm = digest(handoff / "stem.wav")
        subprocess.run([sys.executable, HERE / "score_peer.py", "edit", handoff], check=True)
        call(*adapter, "import", src, "score", draft, "--trust", trust, "--returned", handoff, "--author", "fork-editor")
        frozen = call(*snap, "freeze", draft, child, "--parent", src, "--key", key, "--trust", trust)
        assert frozen["parent"] == base["revision"]
        call(*adapter, "export", child, "score", reopened, "--trust", trust)
        new = inspect_score(reopened / "score.dawproject")
        assert old[:2] == ("120", "bell") and new[:2] == ("96", "reed")
        assert old[2:] == new[2:] and len(new[2]) == 8
        returned_pcm = digest(reopened / "stem.wav")
        assert returned_pcm != old_pcm and returned_pcm == digest(handoff / "stem.wav")
        subprocess.run([sys.executable, HERE / "score_peer.py", "render", reopened], check=True)
        assert returned_pcm == digest(reopened / "stem.wav")
        # A decoder plays the returned stem into a headless sample sink.
        with wave.open(str(reopened / "stem.wav"), "rb") as pcm:
            rate = pcm.getframerate()
            size = pcm.getnframes()
            assert size == 6 * rate and any(pcm.readframes(size))
        seek = lambda n: {"kind":"seek","at":"5000000000","to":{"ticks":str(n),"rate":2}}
        events = [{"kind":"start","at":"0"},{"kind":"advance","at":"2000000000"},{"kind":"advance","at":"5000000000"},seek(5),seek(1)]
        samples = call(core, "bundle-show", child, "episode-one", json.dumps(events))["samples"]
        assert [s["landscapeGraph"] for s in samples] == ["compose","insert-grade","compose","insert-grade","compose"]
        assert len({s["occurrence"] for s in samples}) == len({s["segment"] for s in samples}) == 1
        assert [[c["cue"] for c in s["timeline"]["cues"]] for s in samples] == [[],["sponsor-in"],["sponsor-out"],[],[]]
        onset = samples[1]["timeline"]["position"]
        assert int(onset["ticks"]) * rate // onset["rate"] == int(new[3]["time"]) * rate == 96000
        controls = lambda i, name: next(p["controls"] for p in samples[i]["timeline"]["players"] if p.get("controls") and p["source"] == name)
        assert controls(3,"picture")["saturation"] == .5 and controls(4,"keys")["gain"] == .5
        print(json.dumps({"tempoBpm":[120,96],"instruments":["bell","reed"],"notes":len(new[2]),
                          "pcmFrames":size,"pictureCueSample":96000,"sampleRate":rate,"segmentsVisited":1,
                          "graphSelections":[s["landscapeGraph"] for s in samples],"returnedRevision":frozen["revision"]}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--core", default=os.environ.get("PRODUCER_CORE","producer-core"))
    run(parser.parse_args().core)
