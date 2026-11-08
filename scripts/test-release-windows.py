"""Check platform selection and latest-release policy without publishing assets."""
import ast
from pathlib import Path
import tempfile
import textwrap

root = Path(__file__).resolve().parents[1]
source = (root / "scripts/verify-release-payloads.py").read_text(encoding="utf-8")
tree = ast.parse(source)
selection = []
selecting = False
for node in tree.body:
    if isinstance(node, ast.Assign) and any(
        isinstance(target, ast.Name) and target.id == "arm" for target in node.targets
    ):
        selecting = True
    if selecting and isinstance(node, ast.Assign) and any(
        isinstance(target, ast.Name) and target.id == "manifest" for target in node.targets
    ):
        break
    if selecting:
        selection.append(node)
code = compile(ast.Module(body=selection, type_ignores=[]), str(root), "exec")
version = "0.4.88"
optional = {
    f"Producer_{version}_x64_en-US.msi": {},
    f"Producer_{version}_amd64.deb": {},
    f"Producer-{version}-1.x86_64.rpm": {},
}
for windows_only in (False, True):
    for assets in ({}, optional):
        state = dict(version=version, assets=assets, windows_only=windows_only)
        exec(code, state)
        platforms = state["platforms"]
        assert platforms["windows-x86_64"] == f"Producer_{version}_x64-setup.exe"
        assert platforms["windows-x86_64-nsis"] == platforms["windows-x86_64"]
        assert ("windows-x86_64-msi" in platforms) == bool(assets)
        if windows_only:
            assert all(name.startswith("windows-") for name in platforms)
        else:
            assert platforms["darwin-aarch64"] == f"Producer_{version}_aarch64.app.tar.gz"
            assert platforms["darwin-x86_64"] == "Producer_x64.app.tar.gz"
            assert platforms["linux-x86_64"] == f"Producer_{version}_amd64.AppImage"
            assert ("linux-x86_64-deb" in platforms) == bool(assets)

workflow = (root / ".github/workflows/release.yml").read_text(encoding="utf-8")
linux_job = workflow.split("\n  build:\n", 1)[1].split("\n  build-macos-arm64-live:", 1)[0]
mac_job = workflow.split("\n  build-macos-arm64-live:\n", 1)[1].split("\n  build-windows-live:", 1)[0]
assert "!inputs.windows_only" in linux_job.split("steps:", 1)[0]
assert "!inputs.windows_only" in mac_job.split("steps:", 1)[0]
intel_job = workflow.split("\n  build-macos-intel-live:\n", 1)[1].split("\n  build-windows-live:", 1)[0]
assert 'macos-latest' not in linux_job, 'Intel must not return to the engine-less Linux matrix'
assert 'runs-on: macos-15-intel' in intel_job
assert 'Prepare complete pinned Intel live engine' in intel_job
assert 'PRODUCER_REQUIRE_ENGINE:' in intel_job and '--features guest-rtc-production' in intel_job
assert 'scripts/check-macos-engine.sh' in intel_job and 'scripts/check-camera-bundle.py' in intel_job
assert 'UPD="Producer_x64.app.tar.gz"' in intel_job
assert 'Stage notarized Intel updater archive' in intel_job
assert '--features guest-rtc-production' in (root / 'scripts/dev.sh').read_text()
assert '--features guest-rtc-production' in (root / '.github/workflows/intel-dev.yml').read_text()
publisher = workflow.split("\n  publish-verified-release:\n", 1)[1]
assert "needs.build-windows-live.result == 'success'" in publisher
assert "needs.build-macos-intel-live.result == 'success'" in publisher
assert 'build-macos-intel-live' in publisher.split('runs-on:', 1)[0]
assert "PRODUCER_WINDOWS_ONLY:" in publisher
publish_script = publisher.split("name: Publish the verified release", 1)[1]
publish_script = publish_script.split("python3 - <<'PY'\n", 1)[1].rsplit("          PY", 1)[0]
publish_tree = ast.parse(textwrap.dedent(publish_script))
body_assignment = next(node for node in publish_tree.body if isinstance(node, ast.Assign)
                       and any(isinstance(target, ast.Name) and target.id == "body" for target in node.targets))
with tempfile.TemporaryDirectory() as directory:
    output = Path(directory)
    (output / "release-notes.md").write_text("Windows patch", encoding="utf-8")
    for windows_only in (False, True):
        state = dict(windows_only=windows_only, out=output)
        exec(compile(ast.Module(body=[body_assignment], type_ignores=[]), str(root), "exec"), state)
        assert state["body"]["draft"] is False
        assert state["body"]["make_latest"] == ("false" if windows_only else "true")
print("PASS: Windows-only payloads exclude other platforms and preserve shared latest-release selection.")
