// Experimental renderer descriptor. This is not yet a public Set schema version.
const finite = (x, min, max) => typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max;
const vector = (v, min = -200, max = 200) => Array.isArray(v) && v.length === 3 && v.every(x => finite(x, min, max));
const color = x => typeof x === 'string' && /^#[0-9a-f]{6}$/i.test(x);
export function validateScene(raw) {
  if (!raw || raw.schema !== 'producer.scene3d-proof/1') throw Error('Unsupported 3D proof descriptor');
  if (!finite(raw.fps, 15, 60) || !Number.isInteger(raw.fps)) throw Error('Invalid fps');
  if (!vector(raw.camera?.position) || !vector(raw.camera?.target) || !finite(raw.camera?.fov, 20, 90)) throw Error('Invalid camera');
  if (!color(raw.clearColor) || !color(raw.fog?.color) || !finite(raw.fog?.near, 1, 100) || !finite(raw.fog?.far, raw.fog.near + 1, 200)) throw Error('Invalid environment');
  if (!Array.isArray(raw.objects) || raw.objects.length > 128) throw Error('Object budget exceeded');
  const names = new Set();
  for (const node of raw.objects) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(node.id) || names.has(node.id)) throw Error('Invalid or duplicate object id');
    names.add(node.id);
    const sizes = {box:3, cylinder:4, torus:4, cone:3, plane:2};
    if (!sizes[node.kind] || !Array.isArray(node.args) || node.args.length !== sizes[node.kind] || !node.args.every(x => finite(x, 0.001, 64))) throw Error('Invalid bounded geometry');
    // Restrict mesh subdivision counts, including noninteger values accepted by Three.
    if (node.kind === 'torus' && (!Number.isInteger(node.args[2]) || !Number.isInteger(node.args[3]) || node.args[2] > 32 || node.args[3] > 64)) throw Error('Geometry subdivision budget exceeded');
    if ((node.kind === 'cylinder' || node.kind === 'cone') && (!Number.isInteger(node.args.at(-1)) || node.args.at(-1) > 32)) throw Error('Geometry subdivision budget exceeded');
    if (!vector(node.position) || !vector(node.rotation, -7, 7) || !color(node.color) || !finite(node.metalness,0,1) || !finite(node.roughness,0,1)) throw Error('Invalid material or transform');
    if (node.unlit !== undefined && typeof node.unlit !== 'boolean') throw Error('Invalid material mode');
    if (node.emissive !== undefined && !color(node.emissive)) throw Error('Invalid emissive');
    if (node.opacity !== undefined && !finite(node.opacity,0,1)) throw Error('Invalid opacity');
    if (node.motion && (!['rotateY','swayZ'].includes(node.motion.kind) || !finite(node.motion.speed,-2,2) || !finite(node.motion.amplitude,0,1) || !finite(node.motion.phase,0,7))) throw Error('Invalid motion');
  }
  if (!Array.isArray(raw.slots) || raw.slots.length !== 2 || raw.slots.some(s => !Array.isArray(s) || s.length !== 4 || !s.every(x => finite(x,0,1)) || s[0]+s[2] > 1 || s[1]+s[3] > 1)) throw Error('Invalid native camera placements');
  return structuredClone(raw);
}
export function validateControl(raw) {
  if (!raw || !Number.isSafeInteger(raw.revision) || raw.revision < 0 || !finite(raw.anchor,0,1e15) || typeof raw.paused !== 'boolean' || !finite(raw.elapsed,0,86400000) || !['neutral','blue','gold'].includes(raw.cue)) throw Error('Invalid control snapshot');
  return {revision:raw.revision, anchor:raw.anchor, paused:raw.paused, elapsed:raw.elapsed, cue:raw.cue};
}
