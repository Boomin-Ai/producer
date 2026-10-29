#!/usr/bin/env python3
"""Exercise the real diagnostics helper through a C ABI with broken stderr.

No OBS, camera, application launch, or Cargo build is required. The negative
control must abort; the production helper must return normally.
"""
import json
import os
import signal
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
HELPER = ROOT / "src-tauri/src/live/callback_diagnostics.rs"

with tempfile.TemporaryDirectory(prefix="producer-callback-test-") as folder:
    source = Path(folder) / "probe.rs"
    binary = Path(folder) / "probe"
    source.write_text(
        '#[path = ' + json.dumps(str(HELPER)) + ']\n'
        'mod callback_diagnostics;\n'
        'extern "C" fn callback(safe: bool) {\n'
        '  if safe { callback_diagnostics::write_stderr(format_args!("draw {}", 600)); }\n'
        '  else { eprintln!("draw {}", 600); }\n'
        '}\n'
        'fn main() { callback(std::env::args().nth(1).as_deref() == Some("safe")); }\n'
    )
    subprocess.run(["rustc", "--edition=2021", str(source), "-o", str(binary)], check=True)
    for mode in ("baseline", "safe"):
        read_fd, write_fd = os.pipe()
        os.close(read_fd)
        try:
            result = subprocess.run([str(binary), mode], stderr=write_fd, timeout=10)
        finally:
            os.close(write_fd)
        if mode == "baseline":
            assert result.returncode == -signal.SIGABRT, (
                f"negative control did not abort as expected: {result.returncode}"
            )
        else:
            assert result.returncode == 0, f"callback failed: {result.returncode}"
        print(f"{mode}: exit {result.returncode}")
print("PASS: broken diagnostic output cannot abort the corrected callback")
