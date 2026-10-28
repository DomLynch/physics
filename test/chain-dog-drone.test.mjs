// Ragdoll death for the last two creatures on the chain body kind (src/chain.mjs): the DOG (original-dog.glb, 25-joint rig, 13 capsules like the wolf) and the DRONE
// (low-hover-drone: a procedural model with no skeleton, so ONE capsule for the whole body, no joints). Numbers are placeholders (radii, masses, limits); the tests
// check shape and physical sense, not tuning.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPhysics, buildChainRow, loadChainBody, chainBodyNames, chainBoneMap, chainBoneObjects, validateChainSpec } from "../src/index.mjs";
import { runBudget } from "../tools/budget-seven.mjs";

const read = (f) => JSON.parse(readFileSync(new URL(`../data/bodies/${f}`, import.meta.url), "utf8"));
const rows = JSON.parse(readFileSync(new URL("../data/budget-rows.json", import.meta.url), "utf8"));

const DOG_MAP = {
  hips: "pelvis", chest: "chest", head: "neck", tail_a: "tail_1", tail_b: "tail_2",
  leg_BL_up: "leg_BL", leg_BL_low: "shin_BL", leg_BR_up: "leg_BR", leg_BR_low: "shin_BR",
  leg_FL_up: "leg_FL", leg_FL_low: "shin_FL", leg_FR_up: "leg_FR", leg_FR_low: "shin_FR",
};
const DOG_BONES = ["root", "pelvis", "spine", "chest", "neck", "head", "jaw", "bite_tip", "ear_L", "ear_R", "tail_1", "tail_2", "tail_3",
  "leg_BL", "shin_BL", "paw_BL", "leg_BR", "shin_BR", "paw_BR", "leg_FL", "shin_FL", "paw_FL", "leg_FR", "shin_FR", "paw_FR"];

// closest distance between two segments (Ericson, Real-Time Collision Detection 5.1.9)
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
function segDist(p1, q1, p2, q2) {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2), a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  const c = dot(d1, r), b = dot(d1, d2), den = a * e - b * b;
  let s = den > 1e-12 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0, t = (b * s + f) / e;
  if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); } else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
  return Math.hypot(...sub(add(p1, d1, s), add(p2, d2, t)));
}
const axis = (r) => [add(r.rest.centre, r.rest.dir, -r.half_height_m), add(r.rest.centre, r.rest.dir, r.half_height_m)];

// ---------------------------------------------------------------- DOG
test("dog spec: 13 capsules on the 25-joint dog rig, parent-first, placeholder-marked, scale 2 from Armagedom's model scale, mass plausible", () => {
  const spec = read("dog.chain.json"), bones = read("dog.bones.json");
  assert.equal(spec.schema, "chain-body/1");
  assert.equal(spec.name, "dog");
  assert.equal(bones.schema, "chain-bones/1");
  assert.equal(spec.segments.length, 13);
  assert.equal(spec.scale, 2);
  assert.equal(spec.placeholder, true);
  assert.ok(spec.scale_source && spec.mass_assumption && spec.placeholder_note);
  assert.deepEqual(validateChainSpec(spec, bones), []);
  const total = spec.segments.reduce((a, s) => a + s.mass, 0);
  assert.ok(total > 40 && total < 200, `total mass ${total} kg`);
  assert.deepEqual(Object.keys(bones.bones).sort(), [...DOG_BONES].sort(), "the 25 joints of original-dog.glb, nothing else (the armature nodes are not bones)");
  // measured, not invented: a few world positions from the GLB node JSON with the rotations composed (leg nodes are rotated)
  assert.deepEqual(bones.bones.pelvis.pos, [0, 0.3, -0.23]);
  assert.deepEqual(bones.bones.shin_BL.pos, [-0.086, 0.176, -0.12]);
  assert.deepEqual(bones.bones.bite_tip.pos, [0, 0.348, 0.391]);
});

test("dog: boneMap is the pinned part -> bone table, and every bone with no body follows an owning bone in the scene graph", () => {
  const body = loadChainBody("dog");
  assert.ok(chainBodyNames().includes("dog"));
  assert.deepEqual(body.boneMap, DOG_MAP);
  assert.deepEqual(chainBoneMap(body.spec), DOG_MAP);
  assert.equal(body.row.kind, "chain");
  assert.equal(body.row.schema, "ragdoll-row/2");
  assert.equal(body.row.body, "dog");
  assert.equal(body.row.bodies, 13);
  const found = chainBoneObjects(body.spec, (n) => ({ name: n }));
  assert.deepEqual(Object.values(found).map((o) => o.name), Object.values(DOG_MAP));
  assert.throws(() => chainBoneObjects(body.spec, () => null), /no bone/);
  const owned = new Set(Object.values(DOG_MAP)), bones = body.bones.bones;
  for (const b of Object.keys(bones)) {
    let cur = b;
    while (!owned.has(cur) && bones[cur].parent) cur = bones[cur].parent;
    assert.ok(owned.has(cur) || cur === "root", `bone ${b} has no owning body`);
  }
});

test("dog: capsules follow the bones at the game's model scale (pivot at the bone, length bone to tip, radius x scale), lower legs are hinges, tail and head are the severable units", () => {
  const spec = read("dog.chain.json"), bones = read("dog.bones.json"), row = buildChainRow(spec, bones), S = spec.scale;
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  for (const s of spec.segments) {
    const r = row.roles.find((x) => x.id === s.id), p0 = bones.bones[s.bone].pos.map((x) => x * S), p1 = bones.bones[s.tip].pos.map((x) => x * S);
    assert.ok(d(r.rest.pivot, p0) < 1e-3, `${s.id}: pivot`);
    assert.ok(Math.abs(r.length_m - (d(p0, p1) + (s.extend || 0) * S)) < 1e-3, `${s.id}: length`);
    assert.ok(Math.abs(r.radius_m - s.radius * S) < 1e-4, `${s.id}: radius`);
    assert.ok(r.rest.pivot[1] > 0, `${s.id}: pivot above the floor`);
  }
  assert.ok(row.height_m > 0.5 && row.height_m < 1.2, `height ${row.height_m} m`);
  assert.deepEqual(row.hinge_flex_z, { leg_lower_hind: -1, leg_lower_front: 1 }, "hind knee points forward, front elbow points backward (measured from the bones)");
  for (const id of ["leg_BL_low", "leg_BR_low", "leg_FL_low", "leg_FR_low"]) assert.equal(row.roles.find((x) => x.id === id).joint.type, "hinge", id);
  assert.deepEqual(row.severable.map((s) => s.id), ["tail", "head"]);
  assert.deepEqual(row.severable[0].carries_roles, ["tail_a", "tail_b"]);
  assert.equal(row.severable[1].detaches_from, "chest");
});

test("dog: no two capsules that are not parent and child overlap at rest", () => {
  const { row } = loadChainBody("dog");
  for (let i = 0; i < row.roles.length; i++) for (let j = i + 1; j < row.roles.length; j++) {
    const a = row.roles[i], b = row.roles[j];
    if (a.id === b.parent || b.id === a.parent) continue;
    const [pa, qa] = axis(a), [pb, qb] = axis(b), gap = segDist(pa, qa, pb, qb) - a.radius_m - b.radius_m;
    assert.ok(gap > 0, `${a.id} and ${b.id} overlap by ${(-gap * 100).toFixed(1)} cm at rest`);
  }
});

test("dog: holds its rest pose with the hips kinematic, then a kill with a hit impulse falls, settles and freezes (no NaN, nothing below the floor)", async () => {
  const p = await createPhysics({ seed: 1 });
  const { row, spec } = loadChainBody("dog");
  const rd = p.createRagdoll(row, { id: "dog" });
  assert.equal(rd.partIds.length, 13);
  assert.equal(rd.readPose().length, 130);
  const p0 = Float32Array.from(rd.readPose());
  for (let t = 0; t < 120; t++) p.step(1 / 60);
  let worst = 0;
  const p1 = rd.readPose();
  for (let i = 0; i < 13; i++) worst = Math.max(worst, Math.hypot(p1[i * 10] - p0[i * 10], p1[i * 10 + 1] - p0[i * 10 + 1], p1[i * 10 + 2] - p0[i * 10 + 2]));
  assert.ok(worst < 0.07 * spec.scale, `a part drifted ${worst} m while alive`);
  const hipsY0 = p1[1];
  rd.kill({ part: "chest", impulse: [0, 0, row.total_mass_kg * 0.6] });
  let sawFall = false;
  for (let t = 0; t < 900; t++) { p.step(1 / 60); if (rd.readPose()[1] < hipsY0 - 0.06) sawFall = true; }
  const pose = rd.readPose();
  for (const v of pose) assert.ok(Number.isFinite(v), "NaN or Infinity in the pose");
  assert.ok(sawFall, `hips never dropped (start ${hipsY0})`);
  let maxSpeed = 0, minY = Infinity;
  for (let i = 0; i < 13; i++) { maxSpeed = Math.max(maxSpeed, Math.hypot(pose[i * 10 + 7], pose[i * 10 + 8], pose[i * 10 + 9])); minY = Math.min(minY, pose[i * 10 + 1]); }
  assert.ok(maxSpeed < 0.2, `still moving at ${maxSpeed} m/s after 15 s`);
  assert.ok(minY > -0.02, `a part is below the floor: y ${minY}`);
  assert.equal(rd.state, "frozen");
  p.destroy();
});

test("dog: a tail cut and a head cut both work, and two runs with the same inputs give the same per-tick hash", async () => {
  const run = async () => {
    const p = await createPhysics({ seed: 3 });
    const { row } = loadChainBody("dog");
    const rd = p.createRagdoll(row, { id: "dog" });
    const hashes = [];
    for (let t = 0; t < 300; t++) {
      if (t === 40) { const c = rd.cut("tail"); assert.equal(c.unit, "tail"); assert.ok(c.mass_kg > 0); assert.equal(rd.cut("tail"), null); }
      if (t === 50) assert.equal(rd.cut("head").unit, "head");
      if (t === 60) rd.kill({ part: "chest", impulse: [row.total_mass_kg * 0.06, row.total_mass_kg * 0.01, row.total_mass_kg * 0.6] });
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

// ---------------------------------------------------------------- DRONE
test("drone spec: ONE segment (no skeleton, no joints), root, placeholder-marked, scale 2 from the game data, the model's own size and hover height", () => {
  const spec = read("drone.chain.json"), bones = read("drone.bones.json");
  assert.equal(spec.schema, "chain-body/1");
  assert.equal(spec.name, "drone");
  assert.equal(spec.segments.length, 1);
  const s = spec.segments[0];
  assert.equal(s.parent, null);
  assert.equal(s.joint, null);
  assert.equal(spec.scale, 2);
  assert.equal(spec.placeholder, true);
  assert.ok(spec.scale_source && spec.mass_assumption && spec.placeholder_note && spec.no_skeleton_note);
  assert.deepEqual(spec.severable || [], [], "nothing to cut");
  assert.deepEqual(validateChainSpec(spec, bones), []);
  assert.ok(s.mass > 5 && s.mass < 80, `mass ${s.mass} kg`);
  // the body box in low-hover-drone.js is 0.56 x 0.24 x 0.38 model units: the capsule is as long as the box is wide and no thicker than the box is deep
  const row = buildChainRow(spec, bones);
  assert.ok(Math.abs(row.roles[0].length_m - 1.12) < 0.01, `length ${row.roles[0].length_m} m`);
  assert.ok(row.roles[0].radius_m >= 0.24 && row.roles[0].radius_m <= 0.38, `radius ${row.roles[0].radius_m} m between the box half height (0.24) and half depth (0.38)`);
  assert.ok(Math.abs(row.roles[0].rest.centre[1] - 0.9) < 0.01, "the body centre is at the game's hoverHeight 0.9 m");
});

test("drone: boneMap is {hips: drone_body} and loadChainBody builds a one-body row (no motors, no joints)", () => {
  const body = loadChainBody("drone");
  assert.ok(chainBodyNames().includes("drone"));
  assert.deepEqual(body.boneMap, { hips: "drone_body" });
  assert.equal(body.row.kind, "chain");
  assert.equal(body.row.bodies, 1);
  assert.equal(body.row.roles[0].joint, null);
  assert.equal(body.row.roles[0].motor, undefined);
  assert.deepEqual(body.row.severable, []);
  const found = chainBoneObjects(body.spec, (n) => ({ name: n }));
  assert.equal(found.hips.name, "drone_body");
  assert.throws(() => chainBoneObjects(body.spec, () => null), /no bone/);
});

test("drone: hovers (hips kinematic), then a kill with a hit impulse falls, settles and freezes on the floor with no NaN", async () => {
  const p = await createPhysics({ seed: 1 });
  const { row } = loadChainBody("drone");
  const rd = p.createRagdoll(row, { id: "drone" });
  assert.equal(rd.partIds.length, 1);
  assert.equal(rd.readPose().length, 10);
  // the game's drive() holds the kinematic body at the hover pose every tick (without setRoot the engine drops the body to the floor)
  const { centre, quat } = row.roles[0].rest;
  for (let t = 0; t < 60; t++) { rd.setRoot(centre, quat); p.step(1 / 60); }
  const p1 = rd.readPose();
  assert.ok(Math.abs(p1[1] - 0.9) < 0.01, `a hovering drone is held at 0.9 m: y ${p1[1]}`);
  assert.ok(Math.hypot(p1[0] - centre[0], p1[2] - centre[2]) < 0.01, "and stays where it is");
  rd.kill({ part: "hips", impulse: [0, 0, row.total_mass_kg * 0.1] });
  let fellAt = -1;
  for (let t = 0; t < 900; t++) { p.step(1 / 60); if (fellAt < 0 && rd.readPose()[1] < 0.4) fellAt = t; }
  assert.ok(fellAt >= 0 && fellAt < 60, `the drone did not fall below 0.4 m within 1 s (tick ${fellAt})`);
  const pose = rd.readPose();
  for (const v of pose) assert.ok(Number.isFinite(v), "NaN or Infinity in the pose");
  assert.ok(pose[1] >= row.roles[0].radius_m - 0.04, `the body is below the floor: y ${pose[1]}`);
  assert.ok(Math.hypot(pose[7], pose[8], pose[9]) < 0.2, "still moving after 15 s");
  assert.equal(rd.state, "frozen");
  p.destroy();
});

test("drone: nothing to cut (cut throws on every unit) and two runs with the same inputs give the same per-tick hash", async () => {
  const run = async () => {
    const p = await createPhysics({ seed: 3 });
    const rd = p.createRagdoll(loadChainBody("drone").row, { id: "drone" });
    assert.throws(() => rd.cut("tail"), /unknown severable unit/);
    const hashes = [];
    for (let t = 0; t < 300; t++) {
      if (t === 60) rd.kill({ part: "hips", impulse: [3, 1, 6] });
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

// ---------------------------------------------------------------- budget
test("budget rows: dog_x7 (13 capsules, tail cut, chest hit) and drone_x7 (one body, no cut) are chain sets of seven", () => {
  const dog = rows.sets.find((s) => s.id === "dog_x7"), drone = rows.sets.find((s) => s.id === "drone_x7");
  assert.ok(dog && drone);
  for (const [set, name] of [[dog, "dog"], [drone, "drone"]]) {
    assert.equal(set.kind, "chain");
    assert.deepEqual(set.bodies, Array(7).fill(name));
    assert.ok(set.note && set.impulse_scale > 0, "says how its hit impulse is scaled to the body's mass");
  }
  assert.deepEqual(dog.scenarios, ["alive_idle", "alive_one_cut", "alive_all_cut", "dying_all_cut"]);
  assert.equal(dog.unit_map.arm_right, "tail");
  assert.equal(dog.part_map.spine2, "chest");
  assert.deepEqual(drone.scenarios, ["alive_idle", "dying_uncut"]);
  assert.equal(drone.part_map.spine2, "hips");
  const unc = rows.scenarios.find((s) => s.id === "dying_uncut");
  assert.ok(unc && unc.cuts.length === 0 && unc.kill.tick === 70, "dying_uncut: killed at tick 70, no cut");
});

test("budget run: 1 and 3 bodies of dog_x7 and drone_x7 give finite timings, the cuts land, and the hash repeats", async () => {
  const res = await runBudget(rows, { counts: [1, 3], repeats: 2, ticks: 100, warm_ticks: 10, sets: ["dog_x7", "drone_x7"] });
  assert.equal(res.cells.length, 12, "dog 4 scenarios x 2 counts + drone 2 scenarios x 2 counts");
  for (const c of res.cells) {
    assert.ok(Number.isFinite(c.avg_ms) && c.avg_ms > 0 && c.max_ms >= c.p95_ms, `${c.set} ${c.scenario} n=${c.n}`);
    assert.equal(c.deterministic, true, `${c.set} ${c.scenario} n=${c.n} hash repeats`);
  }
  const cell = (set, sc, n) => res.cells.find((c) => c.set === set && c.scenario === sc && c.n === n);
  assert.equal(cell("dog_x7", "alive_one_cut", 3).cuts, 1);
  assert.equal(cell("dog_x7", "dying_all_cut", 3).cuts, 3);
  assert.equal(cell("drone_x7", "dying_uncut", 3).cuts, 0);
});
