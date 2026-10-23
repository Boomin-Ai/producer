import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const [output, app, startedAt] = process.argv.slice(2);
const digest = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const sources = [
  "engine/obs.lock",
  "src-tauri/src/live/obs_min.h",
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
];
const proof = JSON.parse(
  fs.readFileSync(path.join(output, "proof.json"), "utf8"),
);
if (
  !proof.browser?.htmlAboveNative ||
  !proof.placement?.sharedCaptureIsolation ||
  !proof.sceneOwner?.actualColorTargetBudget ||
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
    "Standalone host; not wired into the room",
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
