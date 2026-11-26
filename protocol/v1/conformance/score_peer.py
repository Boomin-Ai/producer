"""Create, edit and audition the editable score used in the protocol round trip."""
import argparse
from pathlib import Path
import wave
from xml.etree import ElementTree as ET
from zipfile import ZipFile, ZipInfo
import dawdreamer as daw
import numpy as np

RATE = 48000
DURATION = 6
PROGRAMS = {"bell": [1., .1, .02], "reed": [1., .01, .56, .03, .3]}


def archive(path, members):
    with ZipFile(path, "w") as output:
        for name, data in members.items():
            output.writestr(ZipInfo(name), data)


def create(directory):
    root = ET.Element("Project", version="1.0")
    ET.SubElement(root, "Application", name="Producer Protocol", version="1")
    transport = ET.SubElement(root, "Transport")
    ET.SubElement(transport, "Tempo", unit="bpm", value="120")
    ET.SubElement(transport, "TimeSignature", numerator="4", denominator="4")
    track = ET.SubElement(ET.SubElement(root, "Structure"), "Track", id="keys", name="Keys", contentType="notes")
    channel = ET.SubElement(track, "Channel", id="main", role="regular", audioChannels="2")
    ET.SubElement(ET.SubElement(channel, "Devices"), "BuiltinDevice", deviceRole="instrument", deviceID="bell", deviceName="Bell")
    arrangement = ET.SubElement(root, "Arrangement")
    notes = ET.SubElement(ET.SubElement(arrangement, "Lanes", timeUnit="beats"), "Notes", track="keys")
    for beat, pitch in enumerate([60, 64, 67, 71, 69, 67, 64, 60]):
        ET.SubElement(notes, "Note", time=str(beat), duration="0.75", channel="0", key=str(pitch), vel="0.8")
    ET.SubElement(ET.SubElement(arrangement, "Markers", timeUnit="seconds"), "Marker", time="2", name="sponsor-in")
    archive(directory / "score.dawproject", {"project.xml": ET.tostring(root), "metadata.xml": b"<MetaData><Title>Field Notes</Title></MetaData>"})


def render(directory, edit):
    path = directory / "score.dawproject"
    with ZipFile(path) as src:
        members = {name: src.read(name) for name in src.namelist()}
    root = ET.fromstring(members["project.xml"])
    tempo = root.find("./Transport/Tempo")
    instrument = root.find(".//BuiltinDevice")
    if edit:
        tempo.set("value", "96")
        instrument.set("deviceID", "reed")
        instrument.set("deviceName", "Reed")
        members["project.xml"] = ET.tostring(root)
        archive(path, members)
    # The receiver supplies this sampler. The portable WAV is usable on receivers
    # that do not implement the instrument. Notes and the score travel together.
    phase = 2 * np.pi * 261.625565 * np.arange(RATE) / RATE
    waveform = sum(a * np.sin(i * phase) for i, a in enumerate(PROGRAMS[instrument.get("deviceID")], 1))
    waveform *= .4 * np.exp(-2 * np.arange(RATE) / RATE) / np.max(np.abs(waveform))
    engine = daw.RenderEngine(RATE, 128)
    engine.set_bpm(float(tempo.get("value")))
    sampler = engine.make_sampler_processor("Keys", np.ascontiguousarray([waveform, waveform], dtype=np.float32))
    for note in root.findall(".//Note"):
        sampler.add_midi_note(int(note.get("key")), round(float(note.get("vel")) * 127),
                              float(note.get("time")), float(note.get("duration")), beats=True)
    engine.load_graph([(sampler, [])])
    engine.render(DURATION)
    audio = engine.get_audio()
    assert audio.shape == (2, RATE * DURATION) and np.max(np.abs(audio)) > .01
    with wave.open(str(directory / "stem.wav"), "wb") as output:
        output.setparams((2, 2, RATE, 0, "NONE", ""))
        output.writeframes((np.clip(audio.T, -1, 1) * 32767).astype("<i2").tobytes())


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["create", "edit", "render"])
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    if args.action == "create":
        create(args.directory)
    render(args.directory, args.action == "edit")
