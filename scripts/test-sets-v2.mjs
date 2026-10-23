import assert from "node:assert/strict";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "producer-sets-v2-tests-"));
const bundle = await build({
  stdin: {
    contents: `export * from './src/features/sets-v2/data';export * from './src/features/sets-v2/interactions';export * from './src/features/sets-v2/scene';export * from './src/features/sets-v2/motion';export * from './src/features/sets-v2/resources';export * from './src/features/sets-v2/presentation';export * from './src/features/sets-v2/rules';export * from './src/features/sets-v2/fixtures';export * from './src/features/sets-v2/planner';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const file = path.join(dir, "core.mjs");
fs.writeFileSync(file, bundle.outputFiles[0].text);
const core = await import(pathToFileURL(file));
const {
  DataHub,
  PollSession,
  pollDataSchema,
  pollSet,
  compileSet,
  validateDefinition,
  viewport,
  PresentationClock,
  sampleTrack,
  retarget,
  validateClip,
  ResourceRegistry,
  PresentationController,
  ReactionRules,
  planPasses,
} = core;
let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log("PASS", name);
};
const flat = (n) => [n, ...n.children.flatMap(flat)];
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const target = {
  id: "program",
  orientation: "landscape",
  width: 1280,
  height: 720,
  scaling: "contain",
};
const instance = {
  id: "deskRoom",
  definitionId: "poll-bars",
  bindings: { host: "camera-1" },
};
let now = 1000;
const hub = new DataHub("room-1", () => now);
hub.register({
  id: "audiencePoll",
  producer: "audience",
  schema: pollDataSchema,
  maxAgeMs: 5000,
});
const poll = new PollSession({
  id: "tonight",
  question: "Which story next?",
  choices: [
    { id: "a", label: "Beltline" },
    { id: "b", label: "College life" },
  ],
  allowChange: true,
  maxVoters: 2,
});
let rev = 0;
const publish = () =>
  hub.publish(
    { roomId: "room-1", producer: "audience" },
    {
      roomId: "room-1",
      channel: "audiencePoll",
      generation: hub.generation("audiencePoll"),
      revision: ++rev,
      observedAt: now,
      value: poll.data(),
    },
  );
await test("Audience votes remain private until reveal; reset rejects old-round votes", () => {
  poll.start();
  assert.equal(
    poll.cast("member-one", { round: 1, sequence: 1, choice: "a" }),
    "accepted",
  );
  assert.equal(
    poll.cast("member-one", { round: 1, sequence: 1, choice: "b" }),
    "duplicate",
  );
  assert.equal(
    poll.cast("member-two", { round: 1, sequence: 1, choice: "b" }),
    "accepted",
  );
  assert.throws(
    () => poll.cast("member-three", { round: 1, sequence: 1, choice: "a" }),
    /capacity/,
  );
  assert.equal(poll.publicState().results, null);
  assert(!JSON.stringify(poll.data()).includes("member-one"));
  assert.throws(() => poll.reveal(), /Close/);
  poll.cast("member-one", { round: 1, sequence: 2, choice: "b" });
  poll.close();
  poll.reveal();
  assert.equal(poll.publicState().results.total, 2);
  assert.deepEqual(poll.publicState().results.leaders, ["b"]);
  poll.reset();
  poll.start();
  assert.equal(
    poll.cast("member-one", { round: 1, sequence: 3, choice: "a" }),
    "closed",
  );
  assert.equal(poll.publicState().results, null);
});
await test("Typed adapter boundary rejects wrong room/producer, stale revisions and forged resets", () => {
  publish();
  const env = {
    roomId: "room-1",
    channel: "audiencePoll",
    generation: 1,
    revision: rev + 1,
    observedAt: now,
    value: poll.data(),
  };
  assert.throws(
    () => hub.publish({ roomId: "room-2", producer: "audience" }, env),
    /Unauthorized/,
  );
  assert.throws(
    () => hub.publish({ roomId: "room-1", producer: "other" }, env),
    /Unauthorized/,
  );
  assert.equal(
    hub.publish(
      { roomId: "room-1", producer: "audience" },
      { ...env, generation: 2 },
    ),
    "stale",
  );
  assert.equal(
    hub.publish(
      { roomId: "room-1", producer: "audience" },
      { ...env, revision: rev },
    ),
    "stale",
  );
  assert.throws(() =>
    hub.publish(
      { roomId: "room-1", producer: "audience" },
      { ...env, value: { ...poll.data(), execute: "take" } },
    ),
  );
  assert.equal(hub.snapshot().audiencePoll.revision, rev);
  hub.rotate("audiencePoll");
  assert.equal(
    hub.publish({ roomId: "room-1", producer: "audience" }, env),
    "stale",
  );
  publish();
});
await test("Public channel projection excludes operator fields recursively and has independent snapshot ownership", () => {
  const h = new DataHub("r", () => 100);
  h.register({
    id: "feed",
    producer: "adapter",
    maxAgeMs: 50,
    schema: {
      type: "object",
      fields: {
        headline: { type: "string", maxLength: 30 },
        private: {
          type: "object",
          visibility: "operator",
          fields: { secret: { type: "string", maxLength: 50 } },
        },
      },
    },
  });
  h.publish(
    { roomId: "r", producer: "adapter" },
    {
      roomId: "r",
      channel: "feed",
      generation: 1,
      revision: 1,
      observedAt: 100,
      value: { headline: "News", private: { secret: "do-not-render" } },
    },
  );
  const view = h.snapshot();
  assert(!JSON.stringify(view).includes("secret"));
  view.feed.value.headline = "Changed";
  assert.equal(h.snapshot().feed.value.headline, "News");
});
await test("Two different skins and both orientations consume same poll without restarting it", () => {
  poll.cast("member-one", { round: 2, sequence: 1, choice: "a" });
  poll.cast("member-two", { round: 2, sequence: 1, choice: "b" });
  publish();
  for (const style of ["bars", "spotlight"])
    for (const orientation of ["landscape", "portrait"]) {
      const def = pollSet(style);
      const p = compileSet(
        def,
        { ...instance, definitionId: def.id },
        { ...target, orientation },
        hub.snapshot(),
      );
      assert.equal(p.canvasId, orientation);
      assert(!JSON.stringify(p).includes("member-one"));
      if (style === "bars")
        assert.equal(flat(p.root).find((n) => n.id === "bar0").bounds.width, 0);
    }
  poll.close();
  poll.reveal();
  publish();
  const bars = compileSet(pollSet("bars"), instance, target, hub.snapshot());
  assert.equal(flat(bars.root).find((n) => n.id === "bar0").bounds.width, 464);
  const spot = compileSet(
    pollSet("spotlight"),
    { ...instance, definitionId: "poll-spotlight" },
    target,
    hub.snapshot(),
  );
  assert(
    Math.abs(
      flat(spot.root).find((n) => n.id === "candidate0").properties.opacity -
        0.6,
    ) < 1e-10,
  );
  assert.equal(poll.publicState().round, 2);
  assert.deepEqual(poll.publicState().results.leaders, ["a", "b"]);
});
await test("Per-set design canvases scale to output, preserving authored geometry and explicit crop policies", () => {
  const def = pollSet("bars");
  const before = JSON.stringify(def);
  const p = compileSet(def, instance, target, hub.snapshot());
  assert.equal(p.viewport.scaleX, 2 / 3);
  assert.equal(p.root.bounds.width, 1920);
  assert.equal(JSON.stringify(def), before);
  const portrait = {
    ...target,
    orientation: "portrait",
    width: 720,
    height: 1280,
  };
  assert.equal(
    compileSet(def, instance, portrait, hub.snapshot()).viewport.scaleY,
    2 / 3,
  );
  assert.deepEqual(
    viewport(
      { width: 1920, height: 1080 },
      { ...target, width: 1000, height: 1000 },
    ),
    {
      scaleX: 1000 / 1920,
      scaleY: 1000 / 1920,
      offsetX: 0,
      offsetY: 218.75,
      clip: { x: 0, y: 0, width: 1000, height: 1000 },
    },
  );
  const cover = viewport(
    { width: 1920, height: 1080 },
    { ...target, width: 1000, height: 1000, scaling: "cover" },
  );
  assert(cover.offsetX < 0);
  assert.equal(cover.offsetY, 0);
  const stretch = viewport(
    { width: 1920, height: 1080 },
    { ...target, width: 1000, height: 1000, scaling: "stretch" },
  );
  assert.notEqual(stretch.scaleX, stretch.scaleY);
  const custom = structuredClone(def);
  custom.canvases[0].width = 2560;
  custom.canvases[0].height = 1440;
  custom.canvases[0].root.bounds.width = 2560;
  custom.canvases[0].root.bounds.height = 1440;
  assert.equal(
    compileSet(custom, instance, target, hub.snapshot()).viewport.scaleX,
    0.5,
  );
  assert.throws(
    () =>
      compileSet(
        { ...def, canvases: [def.canvases[0]] },
        instance,
        portrait,
        {},
      ),
    /orientation/,
  );
});
await test("Ordered mixed group survives compilation; source readiness and invalid bindings fail closed", () => {
  const d = pollSet("bars");
  const group = d.canvases[0].root.children.find((n) => n.id === "poll");
  group.children.splice(1, 0, {
    id: "inserted-camera",
    kind: "source",
    input: "host",
    fit: "cover",
    bounds: { x: 0, y: 0, width: 100, height: 100 },
  });
  const p = compileSet(d, instance, target, {});
  const g = flat(p.root).find((n) => n.id === "poll");
  assert.deepEqual(
    g.children.slice(0, 3).map((n) => n.kind),
    ["graphic", "source", "text"],
  );
  assert.equal(g.mask.radius, 32);
  assert.equal(g.isolate, true);
  assert.equal(p.resources.filter((k) => k === "camera-1").length, 1);
  assert.throws(
    () => compileSet(d, { ...instance, bindings: {} }, target, {}),
    /Missing source/,
  );
  const bad = structuredClone(d);
  bad.canvases[0].root.children[0].properties = {
    width: { data: { channel: "privateUnknown", path: [] }, fallback: 0 },
  };
  assert.throws(() => validateDefinition(bad), /binding/);
});
await test("Stale data uses authored fallback; host bindings are isolated per set instance", () => {
  now += 6000;
  const p = compileSet(pollSet("bars"), instance, target, hub.snapshot());
  assert.equal(flat(p.root).find((n) => n.id === "bar0").bounds.width, 0);
  assert.equal(
    flat(p.root).find((n) => n.id === "question").properties.text,
    "Ask the audience",
  );
  const other = compileSet(
    pollSet("bars"),
    { ...instance, id: "otherRoom", bindings: { host: "camera-2" } },
    target,
    {},
  );
  assert(other.resources.includes("camera-2"));
  assert.equal(instance.bindings.host, "camera-1");
  now = 8000;
  publish();
});
await test("Audience/external-data rules are edge-triggered, explicitly scoped and host approvals cannot replay", () => {
  const rule = {
    id: "revealRule",
    channel: "audiencePoll",
    path: ["revealed"],
    condition: { op: "equals", value: true },
    trigger: "rising",
    policy: "hostApproved",
    action: { type: "cue.select", cue: "results" },
  };
  const rules = new ReactionRules([rule], ["audiencePoll"], ["results"]);
  const hidden = structuredClone(hub.snapshot());
  hidden.audiencePoll.value.revealed = false;
  assert.deepEqual(rules.evaluate(hidden), []);
  const shown = structuredClone(hidden);
  shown.audiencePoll.revision++;
  shown.audiencePoll.value.revealed = true;
  const proposals = rules.evaluate(shown);
  assert.equal(proposals.length, 1);
  assert(proposals[0].approvalRequired);
  assert.deepEqual(rules.evaluate(shown), []);
  assert.equal(rules.approve(proposals[0].id, shown).approvalRequired, false);
  assert.throws(() => rules.approve(proposals[0].id, shown));
  const auto = new ReactionRules(
    [{ ...rule, trigger: "initialOrRising", policy: "automatic" }],
    ["audiencePoll"],
    ["results"],
  );
  assert.equal(auto.evaluate(shown)[0].approvalRequired, false);
  const bad = new ReactionRules([rule], ["audiencePoll"], ["results"]);
  bad.evaluate(hidden);
  const [pending] = bad.evaluate(shown);
  const stale = structuredClone(shown);
  stale.audiencePoll.stale = true;
  assert.throws(() => bad.approve(pending.id, stale), /current/);
});
await test("Animation has one supplied clock; pause/seek and interrupted retargeting are deterministic", () => {
  let t = 100;
  const clock = new PresentationClock(() => t);
  clock.play();
  t = 600;
  assert.equal(clock.time(), 500);
  clock.pause();
  t = 5000;
  assert.equal(clock.time(), 500);
  clock.seek(100);
  clock.play();
  t += 100;
  assert.equal(clock.time(), 200);
  const track = {
    target: "poll",
    property: "x",
    frames: [
      { atMs: 0, value: 0 },
      { atMs: 1000, value: 100 },
    ],
    easing: "easeInOut",
  };
  validateClip({ id: "move", tracks: [track] });
  assert.equal(sampleTrack(track, 500), 50);
  const next = retarget(track, 500, 0, 300);
  assert.equal(sampleTrack(next, 0), 50);
  assert.equal(sampleTrack(next, 300), 0);
  assert.throws(() => validateClip({ id: "bad", tracks: [track, track] }));
  assert.equal(sampleTrack({ ...track, loop: "pingpong" }, 1500), 50);
});
await test("Shared resources acquire once, survive one lease release and dispose only after the last owner", async () => {
  let creates = 0,
    disposes = 0;
  const registry = new ResourceRegistry(async (key) => {
    creates++;
    return { id: key, dispose: () => disposes++ };
  }, 1);
  const [a, b] = await Promise.all([
    registry.acquire("camera"),
    registry.acquire("camera"),
  ]);
  assert.equal(creates, 1);
  assert.equal(a.value, b.value);
  a.release();
  a.release();
  assert.equal(disposes, 0);
  await assert.rejects(registry.acquire("other"), /budget/);
  b.release();
  assert.equal(disposes, 1);
  assert.equal(registry.size, 0);
  let attempts = 0;
  const retry = new ResourceRegistry(async (key) => {
    if (++attempts === 1) throw Error("device unavailable");
    return { id: key, dispose() {} };
  });
  await assert.rejects(retry.acquire("camera"));
  assert.equal(retry.size, 0);
  (await retry.acquire("camera")).release();
});
await test("One-selection take retains current output on failed prepare and rejects stale candidate completion", async () => {
  const pending = new Map(),
    disposed = [],
    visible = [];
  let frame = 0;
  const presenter = {
    async prepare(plans) {
      const key = plans[0].instanceId;
      if (key === "slow") {
        const d = deferred();
        pending.set(key, d);
        await d.promise;
      }
      if (key === "broken") throw Error("decode failed");
      return { id: key, plans, dispose: () => disposed.push(key) };
    },
    async commit(candidate, guard) {
      if (!guard.swap(() => visible.push(candidate.id)))
        throw Error("superseded");
      return {
        candidateId: candidate.id,
        outputs: candidate.plans.map((p) => p.target.id),
        frame: ++frame,
      };
    },
  };
  const c = new PresentationController(presenter);
  assert.equal(
    await c.select(pollSet("bars"), instance, [target], {}),
    "presented",
  );
  const slow = c.select(
    pollSet("bars"),
    { ...instance, id: "slow" },
    [target],
    {},
  );
  await Promise.resolve();
  await c.select(pollSet("bars"), { ...instance, id: "fresh" }, [target], {});
  pending.get("slow").resolve();
  assert.equal(await slow, "superseded");
  assert.deepEqual(visible, ["deskRoom", "fresh"]);
  assert(disposed.includes("slow"));
  assert.equal(c.current().instanceId, "fresh");
  await assert.rejects(
    c.select(pollSet("bars"), { ...instance, id: "broken" }, [target], {}),
    /decode/,
  );
  assert.equal(c.current().instanceId, "fresh");
  assert(!disposed.includes("fresh"));
  c.dispose();
  assert(disposed.includes("fresh"));
});
await test("Dual-output request compiles all targets before staging; no partial take for missing orientation", async () => {
  let prepares = 0;
  const presenter = {
    prepare() {
      prepares++;
      throw Error("unexpected");
    },
    commit() {
      throw Error("unexpected");
    },
  };
  const c = new PresentationController(presenter);
  const def = pollSet("bars");
  def.canvases = def.canvases.filter((x) => x.orientation === "landscape");
  await assert.rejects(
    c.select(
      def,
      instance,
      [
        target,
        {
          ...target,
          id: "vertical",
          orientation: "portrait",
          width: 1080,
          height: 1920,
        },
      ],
      {},
    ),
    /orientation/,
  );
  assert.equal(prepares, 0);
});
await test("Serialized takes prevent late presented receipts from overwriting newer program ownership", async () => {
  const gate = deferred();
  const visible = [];
  let frame = 0;
  const disposed = [];
  const presenter = {
    async prepare(plans) {
      return {
        id: plans[0].instanceId,
        plans,
        dispose: () => disposed.push(plans[0].instanceId),
      };
    },
    async commit(candidate, guard) {
      if (!guard.swap(() => visible.push(candidate.id)))
        throw Error("cancelled");
      if (candidate.id === "first") await gate.promise;
      return {
        candidateId: candidate.id,
        outputs: ["program"],
        frame: ++frame,
      };
    },
  };
  const c = new PresentationController(presenter);
  const first = c.select(
    pollSet("bars"),
    { ...instance, id: "first" },
    [target],
    {},
  );
  while (!visible.length) await Promise.resolve();
  const second = c.select(
    pollSet("bars"),
    { ...instance, id: "second" },
    [target],
    {},
  );
  await Promise.resolve();
  assert.deepEqual(visible, ["first"]);
  gate.resolve();
  assert.equal(await first, "superseded");
  assert.equal(await second, "presented");
  assert.equal(c.current().instanceId, "second");
  assert(disposed.includes("first"));
  c.dispose();
});
await test("Render planner keeps native sources between graphics batches and isolates mixed masked groups", () => {
  const d = pollSet("bars");
  const g = d.canvases[0].root.children.find((n) => n.id === "poll");
  g.children.splice(1, 0, {
    id: "middle-source",
    kind: "source",
    input: "host",
    fit: "cover",
    bounds: { x: 0, y: 0, width: 300, height: 300 },
  });
  const plan = compileSet(d, instance, target, {});
  const passes = planPasses(plan);
  const start = passes.operations.findIndex(
    (o) => o.op === "begin-group" && o.id === "poll",
  );
  assert(passes.operations[start].offscreen);
  assert.equal(passes.operations[start].mask.radius, 32);
  assert.deepEqual(
    passes.operations.slice(start + 1, start + 4).map((o) => o.op),
    ["graphics", "source", "graphics"],
  );
  assert(passes.graphicsSurfaces >= 3);
  assert.throws(
    () => planPasses(plan, { surfaces: 1, offscreenGroups: 1, rgbaBytes: 1 }),
    /budget/,
  );
});
await test("Definitions, inputs, public properties and malformed data are validated before rendering", () => {
  const d = pollSet("bars");
  const bad = structuredClone(d);
  bad.canvases[0].root.children.push(
    structuredClone(bad.canvases[0].root.children[0]),
  );
  assert.throws(() => validateDefinition(bad), /Duplicate/);
  assert.throws(
    () => validateDefinition({ ...d, script: "alert(1)" }),
    /Unknown/,
  );
  assert.throws(() => viewport({ width: 0, height: 1080 }, target));
  const h = new DataHub("r", () => 100);
  assert.throws(
    () =>
      h.register({
        id: "x",
        producer: "p",
        maxAgeMs: 100,
        schema: {
          type: "object",
          fields: JSON.parse('{"__proto__":{"type":"boolean"}}'),
        },
      }),
    /Unsafe/,
  );
  h.register({
    id: "x",
    producer: "p",
    maxAgeMs: 100,
    schema: { type: "number", min: 0, max: 1 },
  });
  assert.throws(() =>
    h.publish(
      { roomId: "r", producer: "p" },
      {
        roomId: "r",
        channel: "x",
        generation: 1,
        revision: 1,
        observedAt: 100,
        value: NaN,
      },
    ),
  );
  assert.deepEqual(h.snapshot(), {});
  const config = poll.definition;
  config.choices[0].id = "mutated";
  assert.equal(poll.definition.choices[0].id, "a");
});
console.log(
  `Sets v2: ${passed} integration checks passed. Native adapter/hosted transports are not exercised.`,
);
fs.rmSync(dir, { recursive: true, force: true });
