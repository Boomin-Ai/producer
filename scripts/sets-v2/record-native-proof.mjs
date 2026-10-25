import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const [output, app, startedAt] = process.argv.slice(2);
const digest = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const sources = [
  "engine/obs.lock",
  "src-tauri/src/live/obs_min.h",
  "src-tauri/src/live/sets_v2/contract.rs",
  "src-tauri/src/live/sets_v2/mod.rs",
  "src-tauri/src/live/sets_v2/resources.rs",
  "src/features/sets-v2/roomCompiler.ts",
  "src/features/sets-v2/paint.ts",
  "src-tauri/src/live/sets_v2/readiness.c",
  "src-tauri/src/live/sets_v2/readiness.h",
  "src-tauri/src/live/sets_v2/program.c",
  "src-tauri/src/live/sets_v2/program.h",
  "src-tauri/src/live/sets_v2/scene.c",
  "src-tauri/src/live/sets_v2/scene.h",
  "src-tauri/src/live/sets_v2/group.c",
  "src-tauri/src/live/sets_v2/group.h",
  "src-tauri/src/live/sets_v2/transition.c",
  "src-tauri/src/live/sets_v2/transition.h",
  "src/features/sets-v2/scene.ts",
  "src/features/sets-v2/planner.ts",
  "src/features/sets-v2/graphics.ts",
  "scripts/sets-v2/native-probe.m",
  "scripts/sets-v2/run-native-probe.sh",
  "scripts/sets-v2/make-native-plans.mjs",
  "scripts/sets-v2/make-media-fixture.swift",
  "scripts/sets-v2/record-native-proof.mjs",
  "scripts/sets-v2/rust-probe/src/lib.rs",
  "scripts/sets-v2/rust-probe/Cargo.toml",
  "scripts/sets-v2/rust-probe/Cargo.lock",
];
const proof = JSON.parse(
  fs.readFileSync(path.join(output, "proof.json"), "utf8"),
);
if (
  !proof.browser?.htmlAboveNative ||
  !proof.placement?.sharedCaptureIsolation ||
  !proof.sceneOwner?.actualColorTargetBudget ||
  proof.program?.length !== 2 ||
  proof.appAdapter?.length !== 2 ||
  proof.authoredRooms?.length !== 10 ||
  proof.sharpness?.outputResolutionReference?.length !== 8 ||
  proof.sharpness.outputResolutionReference.some(c => c.meanAbsolutePixelError >= 3 || c.softenedStripeFraction >= 0.02) ||
  proof.remainingGroups ||
  proof.remainingSyntheticSources
)
  throw Error("Native evidence incomplete");
const runtime = path.join(app, "Contents/Frameworks/libobs.framework/libobs");
const report = {
  status: "passed",
  startedAt,
  completedAt: new Date().toISOString(),
  platform: process.platform,
  architecture: process.arch,
  runtime: { app, obsVersion: proof.obsVersion, sha256: digest(runtime) },
  staging:
    "isolated ad-hoc-signed host with APFS-cloned frameworks and private CEF profile",
  sources: Object.fromEntries(sources.map((file) => [file, digest(file)])),
  artifacts: Object.fromEntries(
    fs
      .readdirSync(output)
      .filter((file) => /\.(png|json|html)$/.test(file) && file !== "run.json")
      .map((file) => [file, digest(path.join(output, file))]),
  ),
  limitations: [
    "Actual OBS room and exact Rust adapter tested in standalone host; Tauri controls verified separately",
    "Metal on Apple Silicon only",
    "No performance or end-to-end frame-time claim",
    "No physical camera or microphone capture",
    "Fixture bridge is not a native IPC validator",
  ],
};
fs.writeFileSync(
  path.join(output, "run.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log("Recorded native pixel evidence and source hashes");
