#!/usr/bin/env python3
"""Exercise explicit set and show selection and starter cloning in a disposable Rune studio."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile


def check(binary, output):
    with tempfile.TemporaryDirectory(prefix="producer-set-show-") as profile:
        room = Path(profile)
        (room / "boomin-session.json").write_text('{"local":true}')
        env = dict(os.environ, PRODUCER_NATIVE_ROOM_HOME=profile, PRODUCER_NO_AUTO_CAPTURE="1",
                   PRODUCER_DEV_OPEN_LOCAL_ROOM="1", RUNE_OPEN_INACTIVE="1")
        project_file = room / "room.json"

        def render(name, keys=()):
            events = [dict({"type": "click", "key": step} if isinstance(step, str) else step,
                           t=2.5 + index * 0.6) for index, step in enumerate(keys)]
            script = room / "actions.json"
            script.write_text(json.dumps(events))
            tree = output / f"{name}.json"
            subprocess.run([binary, "--realtime", "--size", "1380x980", "--fps", "10",
                            "--frames", str(46 + 6 * len(events)), "--script", script,
                            "--tree", tree, "--snap", output / f"{name}.png"],
                           check=True, timeout=90, env=env)
            return {node["key"]: node for node in json.loads(tree.read_text())["elements"]
                    if node.get("key")}

        def prepare(set_id, edge="right"):
            project = json.loads(project_file.read_text())
            pair = {"landscape": "landscape", "vertical": "vertical"}
            project.update(scene=set_id, mountedSet=set_id, mountedLayout=pair)
            project["roomScenes"][project["activeScene"]].update(mountedSet=set_id, mountedLayout=pair)
            for name, panel in project["workspace"]["panels"].items():
                panel["visible"] = name == "controls"
            project["workspace"]["panels"]["controls"].update(edge=edge, header="hidden")
            for name, dock in project["workspace"]["docks"].items():
                dock.update(hidden=False, collapsed=False, active="controls" if name == edge else None)
            project["workspace"]["docks"][edge]["size"] = 340
            project_file.write_text(json.dumps(project))

        def controller(nodes, show=None):
            players = [key for key in nodes if key.startswith("rundown-")]
            assert players == ([f"rundown-{show}"] if show else []), players
            expected = "Shots" if show else "Layouts"
            assert nodes["set-shots-toggle"]["label"].split()[-1] == expected

        render("startup")
        library = ["edit-set", "set-picker"]
        prepare("classic")
        controller(render("classic-set"))
        for show in ("classic", "native-show", "my-first-million"):
            controller(render(f"show-{show}", library + ["library-shows", f"prepare-show-{show}"]), show)
        started = render("running-show", library + ["library-shows", "prepare-show-native-show",
                                                   "show-native-show-play-pause"])
        controller(started, "native-show")
        assert "set-show-time" in started
        controller(render("set-after-show", library + ["library-shows", "prepare-show-native-show",
                                                      "show-native-show-play-pause"]
                          + library + ["library-installed", "select-classic", "close-editor"]))
        prepare("classic", "bottom")
        controller(render("classic-bottom"))
        prepare("useful-information")
        controller(render("useful-set"))
        before = json.loads(project_file.read_text())["production"]["sets"]
        render("cloned-starter", library + ["clone-podcast-set"])
        after = json.loads(project_file.read_text())["production"]["sets"]
        added = set(after) - set(before)
        assert len(added) == 1, added
        clone = added.pop()
        assert after[clone] == before["useful-information"] == after["useful-information"]
        prepare(clone)
        controller(render("clone-reopened"))
        marker = "Independent episode"
        render("edited-clone", ["edit-set", "editor-text-0", {"type": "key", "name": "a", "cmd": True},
                                {"type": "type", "text": marker, "every": 0.01}, "save-set",
                                "close-editor"])
        saved = json.loads(project_file.read_text())["production"]["sets"]
        for orientation in ("landscape", "vertical"):
            assert marker in json.dumps(saved[clone]["layouts"][orientation]), orientation
        assert saved["useful-information"] == before["useful-information"]
        controller(render("updated-clone-reopened"))
        subprocess.run([binary, "--set-posters", output / "updated-clone"], env=env,
                       check=True, timeout=90)
        for orientation in ("landscape", "portrait"):
            assert (output / "updated-clone" / f"{orientation}.png").stat().st_size > 0
        print(f"Set and show controller checks passed. Screenshots and accessibility trees in {output}.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    check(args.binary.resolve(), args.output.resolve())
