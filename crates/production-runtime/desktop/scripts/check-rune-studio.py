#!/usr/bin/env python3
"""Render and interact with the Rune studio in disposable local profiles."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile


def render(binary, root, size, keys=(), open_studio=True, frames=125):
    root.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, PRODUCER_NATIVE_ROOM_HOME=str(root), PRODUCER_NO_AUTO_CAPTURE="1")
    env.pop("PRODUCER_DEV_OPEN_LOCAL_ROOM", None)
    if open_studio:
        env["PRODUCER_DEV_OPEN_LOCAL_ROOM"] = "1"
    (root / "boomin-session.json").write_text('{"local":true}')
    actions = [dict({"type": "click", "key": key} if isinstance(key, str) else key, t=0.60 + i * 0.42) for i, key in enumerate(keys)]
    script = root / "click.json"
    script.write_text(json.dumps(actions))
    tree = root / "tree.json"
    subprocess.run([binary, "--realtime", "--size", size, "--frames", str(frames),
                    "--script", str(script), "--tree", str(tree)], env=env,
                   stdout=subprocess.DEVNULL, check=True, timeout=90)
    return {node["key"]: node for node in json.loads(tree.read_text())["elements"] if node.get("key")}


def panel_fixture(root, project, panel, edge):
    room = json.loads(project)
    workspace = room["workspace"]
    for name, item in workspace["panels"].items():
        item["visible"] = name == panel
    workspace["panels"][panel]["edge"] = edge
    for name, dock in workspace["docks"].items():
        dock.update(active=panel if name == edge else None, collapsed=False, hidden=False)
    workspace["docks"][edge]["size"] = 280.0 if edge in ("left", "right") else 235.0
    root.mkdir()
    (root / "room.json").write_text(json.dumps(room))


def check(binary, root):
    seed = root / "seed"
    result = render(binary, seed, "1150x720")
    assert {"monitor-0", "monitor-1", "program-transport"} <= result.keys()
    for name, y, height in [("titlebar", 0, 44), ("statusbar", 696, 24)]:
        assert result[f"studio-{name}-material"]["rect"] == [0, y, 1150, height]
        assert result[f"studio-{name}-material"]["rect"] == result[f"studio-{name}"]["rect"]

    for key in ("studios", "edit", "studio-link", "channels", "canvas-mode", "virtual-camera", "record", "broadcast"):
        x, y, width, height = result[key]["rect"]
        assert 72 <= x and 0 <= y and y + height <= 44
    project = (seed / "room.json").read_text()
    shortcut = {"type": "key", "name": "e", "cmd": True}
    click = render(binary, seed, "1150x720", ["edit"])
    keyboard = render(binary, seed, "1150x720", [shortcut])
    for edge in ("left", "right", "top", "bottom"):
        key = f"add-panel-{edge}"
        assert click[key]["rect"] == keyboard[key]["rect"], edge
    assert "add-panel-top" not in render(binary, seed, "1150x720", [shortcut, shortcut])
    menu = render(binary, seed, "1150x720", ["edit", "panels-menu"])
    assert {"toggle-scenes", "workspace-reset"} <= menu.keys()
    resized = root / "resize"
    panel_fixture(resized, project, "scenes", "top")
    path = resized / "room.json"
    room = json.loads(path.read_text())
    room["workspace"]["panels"]["sources"].update(visible=True, edge="top")
    room["workspace"]["docks"]["top"]["collapsed"] = True
    path.write_text(json.dumps(room))
    initial = render(binary, resized, "1150x720")
    divider = next(key for key in initial if key.startswith("split-"))
    dragged = render(binary, resized, "1150x720", [{"type": "drag", "key": divider, "dx": 60}])
    restored = render(binary, resized, "1150x720")
    assert abs(dragged[divider]["rect"][0] - initial[divider]["rect"][0] - 60) < 3
    assert dragged[divider]["rect"] == restored[divider]["rect"]
    moved = render(binary, resized, "1150x720", ["edit", "move-scenes", "move-to-right"])
    assert moved["panel-placeholder-scenes"]["rect"][0] > 800
    hidden = render(binary, resized, "1150x720", ["edit", "hide-scenes"])
    assert "panel-placeholder-scenes" not in hidden
    for edge, size in [("left", "1100x720"), ("right", "1420x820"),
                       ("top", "1420x820"), ("bottom", "980x660")]:
        profile = root / edge
        panel_fixture(profile, project, "dj", edge)
        single = render(binary, profile, size)
        assert "play-0" in single and "play-1" not in single
        mixed = render(binary, profile, size, ["mix"])
        ax, ay, aw, ah = mixed["play-0"]["rect"]
        bx, by, _, _ = mixed["play-1"]["rect"]
        if edge in ("left", "right"):
            assert abs(ax - bx) < 1 and by >= ay + ah, edge
        else:
            assert abs(ay - by) < 1 and bx >= ax + aw, edge
        assert "import-track" in mixed
    for width in (620, 1300):
        cards = render(binary, root / f"picker-{width}", f"{width}x820", ["new"], False)
        assert {"classic", "atmosphere-aerie", "clips", "pilot", "game-show"} <= cards.keys()
        assert "podcast" not in cards
        assert (cards["classic"]["rect"][1] == cards["atmosphere-aerie"]["rect"][1]) == (width >= 696)
    for width in (680, 1200):
        shell = root / f"shell-{width}"
        size = f"{width}x820"
        prefs = render(binary, shell, size, ["settings"], False)
        assert {"back", "prefs-App", "prefs-Integrations", "prefs-Output", "shortcuts"} <= prefs.keys()
        destination = render(binary, shell, size, ["settings", "prefs-Integrations", "add-channel"], False)
        assert {"preset-YouTube", "destination-key", "save-channel"} <= destination.keys()
        profile_sheet = render(binary, shell, size, ["profile"], False)
        assert {"new", "profile-sheet", "close-profile", "email"} <= profile_sheet.keys()
    profile = root / "sequence"
    panel_fixture(profile, project, "timeline", "bottom")
    sequence = render(binary, profile, "1150x720")
    assert sequence["timeline-play"]["rect"][2] < 40
    assert any(key.startswith("trim-") for key in sequence)
    profile = root / "editor"
    panel_fixture(profile, project, "controls", "left")
    editor = render(binary, profile, "1150x720", ["edit-set"])
    assert {"editor-output-0", "editor-output-1", "editor-fields"} <= editor.keys()
    for size in ("1150x720", "720x600"):
        modal = render(binary, profile, size, ["edit-set"])
        assert {"studio-shell", "set-modal-backdrop", "set-editor", "set-layouts", "editor-inspector", "set-picker"} <= modal.keys()
        x, y, w, h = modal["set-editor"]["rect"]
        assert x >= 16 and y >= 16
        preview = modal["editor-output-1"]["rect"]
        inspector = modal["editor-inspector"]["rect"]
        assert modal["set-layouts"]["rect"][1] < preview[1]
        if size == "720x600":
            assert inspector[1] >= preview[1] + preview[3]
        else:
            assert inspector[0] >= preview[0] + preview[2]
        sources = render(binary, profile, size, ["edit-set", "inspect-sources"])
        assert "set-inspector" in sources and "editor-fields" not in sources
        closed = render(binary, profile, size, ["edit-set", "close-editor"])
        assert "studio-shell" in closed and "set-modal-backdrop" not in closed
    controls = render(binary, profile, "1150x720")
    assert controls["edit-set"]["rect"][0] > controls["control-set-output"]["rect"][0]
    for panel in json.loads(project)["workspace"]["panels"]:
        for edge in ("left", "right", "top", "bottom"):
            if panel == "timeline" and edge in ("left", "right"):
                continue
            dock = root / f"panel-{panel}-{edge}"
            panel_fixture(dock, project, panel, edge)
            nodes = render(binary, dock, "1150x720", frames=30)
            x, y, w, h = nodes[f"dock-{edge}-{panel}"]["rect"]
            assert w >= 100 and h >= 100 and x >= 0 and y >= 0, (panel, edge)
            if panel == "guests" and edge == "right":
                assert "guest-link" in nodes and "guest-output-settings" not in nodes
                assert "people-guest-status" not in nodes
                settings = render(binary, dock, "1150x720", ["people-session"])
                assert settings["people-connections-popout"]["label"] == "People settings"
                choices = {"guest-output-Landscape", "guest-output-Portrait"}
                assert choices <= settings.keys()
                path = dock / "room.json"
                single_output = json.loads(path.read_text())
                single_output["canvas"]["view"] = "vertical"
                path.write_text(json.dumps(single_output))
                settings = render(binary, dock, "1150x720", ["people-session"])
                assert "guest-output-settings" in settings and choices.isdisjoint(settings)
            if panel == "sources":
                opened = render(binary, dock, "1150x720", ["device-camera"])
                assert opened["source-popout"]["label"] == "Camera settings"
                assert "camera-effects" in opened
                assert opened["monitor-0"]["rect"] == nodes["monitor-0"]["rect"]
                px, py, pw, ph = opened["source-popout"]["rect"]
                assert 0 <= px <= 1150 - pw and 0 <= py <= 720 - ph
                if edge == "top":
                    closed = render(binary, dock, "1150x720", ["device-camera", {"type": "key", "name": "Escape"}])
                    assert "source-popout" not in closed
    channels = render(binary, profile, "1150x720", ["channels", "add-channel"])
    assert {"destination-server", "destination-key", "save-channel"} <= channels.keys()
    for edge in ("top", "bottom"):
        profile = root / f"assistant-{edge}"
        panel_fixture(profile, project, "assistant", edge)
        expanded = render(binary, profile, "1150x720", frames=30)
        assert {"assistant-transcript", "assistant-logs", "assistant-input"} <= expanded.keys()
        assert "assistant-quick" not in expanded
        path = profile / "room.json"
        doc = json.loads(path.read_text())
        doc["workspace"]["docks"][edge]["collapsed"] = True
        path.write_text(json.dumps(doc))
        compact = render(binary, profile, "1150x720", frames=30)
        assert "assistant-quick" in compact and "assistant-input" not in compact
        opened = render(binary, profile, "1150x720", ["assistant-open"])
        assert {"assistant-popout", "assistant-transcript", "assistant-logs", "assistant-input"} <= opened.keys()
        assert "assistant-quick" not in opened
        assert opened["monitor-0"]["rect"] == compact["monitor-0"]["rect"]
        x, y, w, h = opened["assistant-popout"]["rect"]
        assert 0 <= x <= 1150 - w and 0 <= y <= 720 - h and 0 < w < 500
        closed = render(binary, profile, "1150x720", ["assistant-open", {"type": "key", "name": "Escape"}])
        assert "assistant-popout" not in closed and "assistant-quick" in closed


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="producer-rune-check-") as sandbox:
        check(str(args.binary.resolve()), Path(sandbox))
    print("Rune studio layout and interaction checks passed.")
