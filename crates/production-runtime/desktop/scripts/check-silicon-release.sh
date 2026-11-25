#!/bin/bash
set -euo pipefail
binary="$1"
reference="$(dirname "$0")/check-rune-studio.py"
python3 - "$binary" "$reference" "$2" <<'PY'
import importlib.util
import json
from pathlib import Path
import sys
import tempfile

binary, reference, scratch = sys.argv[1:]
spec = importlib.util.spec_from_file_location("studio", reference)
studio = importlib.util.module_from_spec(spec)
spec.loader.exec_module(studio)
with tempfile.TemporaryDirectory(prefix="release-studio-", dir=scratch) as directory:
    root = Path(directory)
    initial = studio.render(Path(binary), root, "1150x720")
    assert {"monitor-0", "monitor-1", "program-transport"} <= initial.keys()
    draft = studio.render(Path(binary), root, "1150x720", ["studio-settings"])
    assert {"studio-shell", "studio-settings-sheet"} <= draft.keys()
    workspace = json.loads((root / "room.json").read_text())
    profile = root / "timeline"
    studio.panel_fixture(profile, json.dumps(workspace), "timeline", "bottom")
    layout = studio.render(Path(binary), profile, "1150x720", ["close-timeline"])
    assert "sequence" not in layout
    reopened = studio.render(Path(binary), profile, "1150x720")
    assert "sequence" not in reopened and "monitor-preview" not in reopened
PY
