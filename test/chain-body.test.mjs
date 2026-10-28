// Chain ragdoll body kind (src/chain.mjs) and its first creature, the salamander (31-bone quadruped rig): the spec validates, the built ragdoll-row/2 makes a
// ragdoll that stands, dies, falls and settles, the run is deterministic, and the humanoid rows are untouched by the row-driven hinge lookup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPhysics, buildChainRow, loadChainBody, chainBoneMap, validateChainSpec } from "../src/index.mjs";
import { buildDefinition } from "../src/engine.mjs";

const read = (f) => JSON.parse(readFileSync(new URL(`../data/bodies/${f}`, import.meta.url), "utf8"));
const spec = read("salamander.chain.json"), bones = read("salamander.bones.json");
const vlen = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test("salamander spec: parent-first, unique ids, positive radius and mass, every bone exists in the measurement file", () => {
  assert.equal(spec.schema, "chain-body/1");
  assert.equal(spec.segments.length, 13);
  const seen = new Set();
  spec.segments.forEach((s, i) => {
    assert.ok(!seen.has(s.id), `duplicate id ${s.id}`);
    if (i === 0) assert.equal(s.parent, null, "roles[0] is the root");
    else assert.ok(seen.has(s.parent), `${s.id}: parent ${s.parent} must come before it`);
    seen.add(s.id);
    assert.ok(s.radius > 0 && s.mass > 0, `${s.id}: radius and mass must be positive`);
    assert.ok(bones.bones[s.bone], `${s.id}: bone ${s.bone} missing from salamander.bones.json`);
    assert.ok(bones.bones[s.tip], `${s.id}: tip ${s.tip} missing from salamander.bones.json`);
    assert.ok(s.joint === null ? i === 0 : s.joint.type === "ball" || s.joint.type === "hinge", `${s.id}: joint`);
  });
  const total = spec.segments.reduce((a, s) => a + s.mass, 0);
  assert.ok(total > 100 && total < 600, `total mass ${total} kg is not plausible for a 3.6 m salamander`);
  assert.equal(spec.placeholder, true, "the numbers are marked as placeholders until tuned");
  assert.deepEqual(validateChainSpec(spec, bones), []);
});

test("validateChainSpec: refuses a child before its parent, a duplicate id, a zero radius, a missing bone, a bad joint", () => {
  const clone = () => JSON.parse(JSON.stringify(spec));
  const errs = (mutate) => { const s = clone(); mutate(s); return validateChainSpec(s, bones); };
  assert.ok(errs((s) => { s.segments.reverse(); }).length > 0, "reversed order");
  assert.ok(errs((s) => { s.segments[1].id = "hips"; }).length > 0, "duplicate id");
  assert.ok(errs((s) => { s.segments[2].radius = 0; }).length > 0, "zero radius");
  assert.ok(errs((s) => { s.segments[2].mass = -1; }).length > 0, "negative mass");
  assert.ok(errs((s) => { s.segments[2].bone = "no_such_bone"; }).length > 0, "missing bone");
  assert.ok(errs((s) => { s.segments[2].joint = { type: "slider" }; }).length > 0, "bad joint type");
  assert.ok(errs((s) => { s.segments[0].joint = { type: "ball", swing_deg: 10, twist_deg: 10 }; }).length > 0, "root with a joint");
});

test("buildChainRow: a ragdoll-row/2 with the humanoid row's fields the engine reads", () => {
  const row = buildChainRow(spec, bones);
  assert.equal(row.schema, "ragdoll-row/2");
  assert.equal(row.kind, "chain");
  assert.equal(row.roles.length, 13);
  assert.equal(row.bodies, 13);
  assert.equal(row.roles[0].id, "hips");
  assert.equal(row.roles[0].parent, null);
  assert.ok(row.inertia_multiplier > 0 && Array.isArray(row.severable));
  assert.deepEqual(row.hinge_flex_z, spec.hinge_flex_z);
  assert.ok(Math.abs(row.total_mass_kg - spec.segments.reduce((a, s) => a + s.mass, 0)) < 0.01);
  const ids = new Set();
  for (const r of row.roles) {
    ids.add(r.id);
    assert.ok(r.radius_m > 0 && r.half_height_m > 0 && r.mass_kg > 0, r.id);
    assert.equal(r.rest.centre.length, 3); assert.equal(r.rest.quat.length, 4); assert.equal(r.rest.pivot.length, 3); assert.equal(r.rest.dir.length, 3);
    assert.ok(Math.abs(Math.hypot(...r.rest.quat) - 1) < 1e-5 && Math.abs(Math.hypot(...r.rest.dir) - 1) < 1e-4, r.id);
    if (r.parent) { assert.ok(ids.has(r.parent), r.id); assert.ok(r.motor.stiffness_Nm_per_rad > 0 && r.motor.damping_Nm_s_per_rad > 0, r.id); }
  }
});

test("buildChainRow: capsule geometry follows the bones at the model scale (pivot at the bone, length bone to tip)", () => {
  const row = buildChainRow(spec, bones), S = spec.scale;
  for (const s of spec.segments) {
    const r = row.roles.find((x) => x.id === s.id), p0 = bones.bones[s.bone].pos.map((x) => x * S), p1 = bones.bones[s.tip].pos.map((x) => x * S);
    assert.ok(vlen(r.rest.pivot, p0) < 1e-3, `${s.id}: pivot is the ${s.bone} bone`);
    const want = vlen(p0, p1) + (s.extend || 0) * S;
    assert.ok(Math.abs(r.length_m - want) < 1e-3, `${s.id}: length ${r.length_m} vs ${want}`);
    assert.ok(Math.abs(r.radius_m - s.radius * S) < 1e-4, `${s.id}: radius`);
    // centre is half the length along dir from the pivot; the capsule's local Y is dir
    assert.ok(vlen(r.rest.centre, [0, 1, 2].map((k) => r.rest.pivot[k] + r.rest.dir[k] * r.length_m / 2)) < 1e-3, `${s.id}: centre`);
  }
});

test("chainBoneMap: part id -> bone name for every part, the shape the game hands createThreeRig", () => {
  const map = chainBoneMap(spec);
  assert.equal(Object.keys(map).length, 13);
  assert.equal(map.hips, "spine0");
  assert.equal(map.chest, "spine2");
  assert.equal(map.head, "neck");
  assert.equal(map.hind_low_L, "hind_low_L");
  for (const [part, bone] of Object.entries(map)) assert.ok(bones.bones[bone], `${part} -> ${bone}`);
  const body = loadChainBody("salamander");
  assert.deepEqual(body.boneMap, map);
  assert.deepEqual(body.row.roles.map((r) => r.id), Object.keys(map));
  assert.throws(() => loadChainBody("no-such-creature"), /no-such-creature/);
});

test("hinge flexion is row-driven: a hind knee and a front elbow flex opposite ways, and a humanoid row without the map keeps its shin default", async () => {
  const row = buildChainRow(spec, bones);
  const flipped = JSON.parse(JSON.stringify(row)); flipped.hinge_flex_z = { leg_lower_hind: 1, leg_lower_front: -1 };
  const a = buildDefinition(row, [0, 0, 0]), b = buildDefinition(flipped, [0, 0, 0]);
  for (const id of ["hind_low_L", "hind_low_R", "front_low_L", "front_low_R"]) {
    const i = row.roles.findIndex((r) => r.id === id);
    assert.notDeepEqual(a.limits[i], b.limits[i], `${id}: flipping the row flips the limits`);
  }
  // the row map replaces the world row (hinge_flex_z.forearm 1 / shin -1) and the hard-coded shin fallback: a role not in it flexes +1
  const none = JSON.parse(JSON.stringify(row)); none.hinge_flex_z = {};
  const c = buildDefinition(none, [0, 0, 0]);
  const hi = row.roles.findIndex((r) => r.id === "hind_low_L");
  assert.notDeepEqual(a.limits[hi], c.limits[hi], "hind knee with -1 differs from the +1 default");
  // humanoid: no row map, the world row and the shin fallback still apply, bit for bit
  const probe = await createPhysics({ seed: 1 });
  const human = probe.createRagdoll(read("minotaur.measure.json")).row;
  probe.destroy();
  assert.equal(human.hinge_flex_z, undefined);
  const shin = human.roles.findIndex((r) => r.role === "shin");
  assert.deepEqual(buildDefinition(human, [0, 0, 0], {}).limits[shin], buildDefinition(human, [0, 0, 0], { shin: -1 }).limits[shin]);
});

test("createRagdoll from the built row makes 13 bodies, and the visual-only humanoid units are not added to a chain row", async () => {
  const p = await createPhysics({ seed: 1 });
  const { row } = loadChainBody("salamander");
  const rd = p.createRagdoll(row, { id: "sal" });
  assert.equal(rd.partIds.length, 13);
  assert.equal(rd.readPose().length, 130);
  assert.deepEqual(rd.row.severable.map((s) => s.id), ["tail"]);
  p.destroy();
});

test("the salamander holds its rest pose with the hips kinematic", async () => {
  const p = await createPhysics({ seed: 1 });
  const rd = p.createRagdoll(loadChainBody("salamander").row, { id: "sal" });
  const p0 = Float32Array.from(rd.readPose());
  for (let t = 0; t < 120; t++) p.step(1 / 60);
  const p1 = rd.readPose();
  let worst = 0;
  for (let i = 0; i < 13; i++) worst = Math.max(worst, Math.hypot(p1[i * 10] - p0[i * 10], p1[i * 10 + 1] - p0[i * 10 + 1], p1[i * 10 + 2] - p0[i * 10 + 2]));
  for (const v of p1) assert.ok(Number.isFinite(v));
  assert.ok(worst < 0.25, `a part drifted ${worst} m`);
  p.destroy();
});

test("kill with a hit impulse: the salamander falls, settles and freezes on the floor, no NaN, nothing under the floor", async () => {
  const p = await createPhysics({ seed: 1 });
  const rd = p.createRagdoll(loadChainBody("salamander").row, { id: "sal" });
  for (let t = 0; t < 30; t++) p.step(1 / 60);
  const hipsY0 = rd.readPose()[1];
  rd.kill({ part: "chest", impulse: [0, 0, 300] });
  let sawFall = false;
  for (let t = 0; t < 900; t++) { p.step(1 / 60); if (rd.readPose()[1] < hipsY0 - 0.15) sawFall = true; }
  const pose = rd.readPose();
  for (const v of pose) assert.ok(Number.isFinite(v), "NaN or Infinity in the pose");
  assert.ok(sawFall, `hips never dropped (start ${hipsY0})`);
  assert.ok(pose[1] < hipsY0 - 0.15, `hips at ${pose[1]} m, start ${hipsY0} m`);
  let maxSpeed = 0, minY = Infinity;
  for (let i = 0; i < 13; i++) { maxSpeed = Math.max(maxSpeed, Math.hypot(pose[i * 10 + 7], pose[i * 10 + 8], pose[i * 10 + 9])); minY = Math.min(minY, pose[i * 10 + 1]); }
  assert.ok(maxSpeed < 0.2, `still moving at ${maxSpeed} m/s after 15 s`);
  assert.ok(minY > -0.02, `a part is below the floor: y ${minY}`);
  assert.equal(rd.state, "frozen");
  p.destroy();
});

test("a tail cut works on the chain row: the joint goes, tail_a and tail_b fall free, the rest stays", async () => {
  const p = await createPhysics({ seed: 1 });
  const rd = p.createRagdoll(loadChainBody("salamander").row, { id: "sal" });
  const r = rd.cut("tail");
  assert.equal(r.unit, "tail");
  assert.deepEqual(r.carries_roles, ["tail_a", "tail_b"]);
  assert.ok(r.mass_kg > 0);
  assert.equal(rd.cut("tail"), null, "a second cut finds no joint");
  for (let t = 0; t < 60; t++) p.step(1 / 60);
  for (const v of rd.readPose()) assert.ok(Number.isFinite(v));
  assert.throws(() => rd.cut("head"), /unknown severable unit/);
  p.destroy();
});

test("deterministic: two runs with the same inputs give the same per-tick hash", async () => {
  const run = async () => {
    const p = await createPhysics({ seed: 3 });
    const rd = p.createRagdoll(loadChainBody("salamander").row, { id: "sal" });
    const hashes = [];
    for (let t = 0; t < 300; t++) {
      if (t === 40) rd.cut("tail");
      if (t === 60) rd.kill({ part: "chest", impulse: [20, 5, 300] });
      p.step(1 / 60);
      hashes.push(p.hash());
    }
    p.destroy();
    return hashes;
  };
  const a = await run(), b = await run();
  assert.deepEqual(a, b);
  assert.notEqual(a[0], a[299], "the sim must actually move");
});

test("humanoid rows are unaffected: pose and state behave as before (hash of a pinned run is stable across two runs, hinge flex from the world row)", async () => {
  const body = read("minotaur.measure.json");
  const run = async () => {
    const p = await createPhysics({ seed: 7 });
    const rd = p.createRagdoll(body, { id: "m" });
    const hashes = [];
    for (let t = 0; t < 120; t++) { if (t === 30) rd.kill({ part: "spine2", impulse: [0, 0, 60] }); p.step(1 / 60); hashes.push(p.hash()); }
    p.destroy();
    return hashes;
  };
  assert.deepEqual(await run(), await run());
  const p = await createPhysics({ seed: 1 });
  const row = p.createRagdoll(body).row;
  p.destroy();
  assert.equal(row.kind, undefined);
  assert.ok(row.severable.some((s) => s.id === "head_split"), "visual-only units still added to humanoid rows");
});
