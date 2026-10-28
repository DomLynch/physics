// The rest of the quadruped family on the chain body kind (src/chain.mjs): eel, elephant, wolf (the salamander is in chain-body.test.mjs). Each spec validates against its
// measured bones, builds a ragdoll-row/2 that stands, dies, falls and settles, cuts its tail and head, repeats bit for bit, has no overlapping capsules at rest,
// and has a budget set. Numbers are placeholders (radii, masses, limits); the tests check shape and physical sense, not tuning.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPhysics, buildChainRow, loadChainBody, chainBodyNames, chainBoneMap, chainBoneObjects, validateChainSpec } from "../src/index.mjs";
import { runBudget } from "../tools/budget-seven.mjs";

const read = (f) => JSON.parse(readFileSync(new URL(`../data/bodies/${f}`, import.meta.url), "utf8"));
const rows = JSON.parse(readFileSync(new URL("../data/budget-rows.json", import.meta.url), "utf8"));

// what each body must look like: part count, game model scale (Armagedom creatureDefinitions.json scale.model), plausible total mass, the part -> bone map
const WANT = {
  eel: {
    parts: 7, scale: 0.9, mass: [0.5, 10], tailUnit: ["tail_a", "tail_b", "tail_c"], headCutParent: "chest_b",
    map: { hips: "spine0", chest_a: "spine2", chest_b: "spine4", head: "neck", tail_a: "tail0", tail_b: "tail1", tail_c: "tail2" },
  },
  elephant: {
    parts: 13, scale: 5, mass: [1500, 6000], tailUnit: ["tail_a", "tail_b"], headCutParent: "chest",
    map: { hips: "spine0", chest: "spine2", head: "neck", tail_a: "tail0", tail_b: "tail2",
      hind_up_L: "hind_up_L", hind_low_L: "hind_low_L", hind_up_R: "hind_up_R", hind_low_R: "hind_low_R",
      front_up_L: "front_up_L", front_low_L: "front_low_L", front_up_R: "front_up_R", front_low_R: "front_low_R" },
  },
  wolf: {
    parts: 13, scale: 2.5, mass: [60, 250], tailUnit: ["tail_a", "tail_b"], headCutParent: "chest",
    map: { hips: "spine0", chest: "spine2", head: "neck", tail_a: "tail0", tail_b: "tail2",
      hind_up_L: "hind_up_L", hind_low_L: "hind_low_L", hind_up_R: "hind_up_R", hind_low_R: "hind_low_R",
      front_up_L: "front_up_L", front_low_L: "front_low_L", front_up_R: "front_up_R", front_low_R: "front_low_R" },
  },
};
const NAMES = Object.keys(WANT);

// closest distance between two segments (Ericson, Real-Time Collision Detection 5.1.9)
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
function segDist(p1, q1, p2, q2) {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2), a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s, t;
  const c = dot(d1, r), b = dot(d1, d2), den = a * e - b * b;
  s = den > 1e-12 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
  t = (b * s + f) / e;
  if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); } else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
  const c1 = add(p1, d1, s), c2 = add(p2, d2, t);
  return Math.hypot(...sub(c1, c2));
}
const axis = (r) => [add(r.rest.centre, r.rest.dir, -r.half_height_m), add(r.rest.centre, r.rest.dir, r.half_height_m)];

for (const name of NAMES) {
  const W = WANT[name];

  test(`${name}: spec is valid against its measured bones (parent-first, positive radius and mass, every bone exists, placeholder flag, scale from the game data)`, () => {
    const spec = read(`${name}.chain.json`), bones = read(`${name}.bones.json`);
    assert.equal(spec.schema, "chain-body/1");
    assert.equal(spec.name, name);
    assert.equal(bones.schema, "chain-bones/1");
    assert.equal(Object.keys(bones.bones).length, 31, "31-bone quadruped rig");
    assert.equal(spec.segments.length, W.parts);
    assert.equal(spec.scale, W.scale);
    assert.ok(spec.scale_source && spec.mass_assumption && spec.placeholder_note, "scale, mass and the placeholder status are explained in the file");
    assert.equal(spec.placeholder, true);
    const total = spec.segments.reduce((a, s) => a + s.mass, 0);
    assert.ok(total > W.mass[0] && total < W.mass[1], `total mass ${total} kg outside ${W.mass}`);
    assert.deepEqual(validateChainSpec(spec, bones), []);
  });

  test(`${name}: boneMap is exactly the expected part -> bone map and loadChainBody builds it`, () => {
    assert.ok(chainBodyNames().includes(name));
    const body = loadChainBody(name);
    assert.deepEqual(body.boneMap, W.map);
    assert.deepEqual(chainBoneMap(body.spec), W.map);
    assert.equal(body.row.kind, "chain");
    assert.equal(body.row.schema, "ragdoll-row/2");
    assert.equal(body.row.bodies, W.parts);
    const found = chainBoneObjects(body.spec, (n) => ({ name: n }));
    assert.deepEqual(Object.values(found).map((o) => o.name), Object.values(W.map));
    assert.throws(() => chainBoneObjects(body.spec, () => null), /no bone/);
  });

  test(`${name}: capsules follow the bones at the game's model scale (pivot at the bone, length bone to tip, radius x scale)`, () => {
    const spec = read(`${name}.chain.json`), bones = read(`${name}.bones.json`), row = buildChainRow(spec, bones), S = spec.scale;
    const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    for (const s of spec.segments) {
      const r = row.roles.find((x) => x.id === s.id), p0 = bones.bones[s.bone].pos.map((x) => x * S), p1 = bones.bones[s.tip].pos.map((x) => x * S);
      assert.ok(d(r.rest.pivot, p0) < 1e-3, `${s.id}: pivot`);
      assert.ok(Math.abs(r.length_m - (d(p0, p1) + (s.extend || 0) * S)) < 1e-3, `${s.id}: length`);
      assert.ok(Math.abs(r.radius_m - s.radius * S) < 1e-4, `${s.id}: radius`);
    }
  });

  test(`${name}: no two capsules that are not parent and child overlap at rest (an overlapping start pose blows the joints apart)`, () => {
    const { row } = loadChainBody(name);
    for (let i = 0; i < row.roles.length; i++) for (let j = i + 1; j < row.roles.length; j++) {
      const a = row.roles[i], b = row.roles[j];
      if (a.id === b.parent || b.id === a.parent) continue; // the engine turns off collision between a joint's two bodies
      const [pa, qa] = axis(a), [pb, qb] = axis(b), gap = segDist(pa, qa, pb, qb) - a.radius_m - b.radius_m;
      assert.ok(gap > 0, `${a.id} and ${b.id} overlap by ${(-gap * 100).toFixed(1)} cm at rest`);
    }
  });

  test(`${name}: createRagdoll makes ${W.parts} bodies and holds its rest pose with the hips kinematic`, async () => {
    const p = await createPhysics({ seed: 1 });
    const { row, spec } = loadChainBody(name);
    const rd = p.createRagdoll(row, { id: name });
    assert.equal(rd.partIds.length, W.parts);
    assert.equal(rd.readPose().length, W.parts * 10);
    const p0 = Float32Array.from(rd.readPose());
    for (let t = 0; t < 120; t++) p.step(1 / 60);
    const p1 = rd.readPose();
    let worst = 0;
    for (let i = 0; i < W.parts; i++) worst = Math.max(worst, Math.hypot(p1[i * 10] - p0[i * 10], p1[i * 10 + 1] - p0[i * 10 + 1], p1[i * 10 + 2] - p0[i * 10 + 2]));
    for (const v of p1) assert.ok(Number.isFinite(v));
    assert.ok(worst < 0.07 * spec.scale, `a part drifted ${worst} m`);
    p.destroy();
  });

  test(`${name}: kill with a hit impulse: falls, settles and freezes on the floor, no NaN, nothing under the floor`, async () => {
    const p = await createPhysics({ seed: 1 });
    const { row, spec } = loadChainBody(name);
    const rd = p.createRagdoll(row, { id: name });
    for (let t = 0; t < 30; t++) p.step(1 / 60);
    const hipsY0 = rd.readPose()[1], drop = 0.03 * spec.scale;
    rd.kill({ part: "chest" in W.map ? "chest" : "chest_a", impulse: [0, 0, row.total_mass_kg] });
    let sawFall = false;
    for (let t = 0; t < 900; t++) { p.step(1 / 60); if (rd.readPose()[1] < hipsY0 - drop) sawFall = true; }
    const pose = rd.readPose();
    for (const v of pose) assert.ok(Number.isFinite(v), "NaN or Infinity in the pose");
    assert.ok(sawFall, `hips never dropped by ${drop} (start ${hipsY0})`);
    let maxSpeed = 0, minY = Infinity;
    for (let i = 0; i < W.parts; i++) { maxSpeed = Math.max(maxSpeed, Math.hypot(pose[i * 10 + 7], pose[i * 10 + 8], pose[i * 10 + 9])); minY = Math.min(minY, pose[i * 10 + 1]); }
    assert.ok(maxSpeed < 0.2, `still moving at ${maxSpeed} m/s after 15 s`);
    assert.ok(minY > -0.02, `a part is below the floor: y ${minY}`);
    assert.equal(rd.state, "frozen");
    p.destroy();
  });

  test(`${name}: a tail cut and a head cut both work on the chain row`, async () => {
    const p = await createPhysics({ seed: 1 });
    const { row } = loadChainBody(name);
    assert.deepEqual(row.severable.map((s) => s.id), ["tail", "head"]);
    const tail = row.severable.find((s) => s.id === "tail"), head = row.severable.find((s) => s.id === "head");
    assert.deepEqual(tail.carries_roles, W.tailUnit);
    assert.deepEqual(head.carries_roles, ["head"]);
    assert.equal(head.detaches_from, W.headCutParent);
    const rd = p.createRagdoll(row, { id: name });
    const r = rd.cut("tail");
    assert.equal(r.unit, "tail");
    assert.ok(r.mass_kg > 0);
    assert.equal(rd.cut("tail"), null, "a second cut finds no joint");
    assert.equal(rd.cut("head").unit, "head");
    for (let t = 0; t < 60; t++) p.step(1 / 60);
    for (const v of rd.readPose()) assert.ok(Number.isFinite(v));
    assert.throws(() => rd.cut("arm_right"), /unknown severable unit/);
    p.destroy();
  });

  test(`${name}: deterministic, two runs with the same inputs give the same per-tick hash`, async () => {
    const run = async () => {
      const p = await createPhysics({ seed: 3 });
      const { row } = loadChainBody(name);
      const rd = p.createRagdoll(row, { id: name });
      const hashes = [];
      for (let t = 0; t < 300; t++) {
        if (t === 40) rd.cut("tail");
        if (t === 60) rd.kill({ part: "chest" in W.map ? "chest" : "chest_a", impulse: [row.total_mass_kg * 0.1, row.total_mass_kg * 0.02, row.total_mass_kg] });
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
}

test("eel: legs are visual only (no leg bone has a body), the spine and tail are a 5 to 8 capsule ball-jointed chain", () => {
  const spec = read("eel.chain.json");
  assert.ok(spec.segments.length >= 5 && spec.segments.length <= 8);
  for (const s of spec.segments) {
    assert.ok(!/^(hind|front)_/.test(s.bone) && !/^(hind|front)_/.test(s.tip), `${s.id} uses a leg bone`);
    if (s.joint) assert.equal(s.joint.type, "ball", `${s.id}: only ball joints`);
  }
  assert.deepEqual(spec.hinge_flex_z || {}, {});
  assert.match(spec.legs_note || "", /visual/i, "the file says the legs follow their parent bones");
});

test("elephant and wolf: same skeleton, the elephant is much heavier with thicker limbs, the wolf is the lighter long-legged one", () => {
  const e = loadChainBody("elephant").row, w = loadChainBody("wolf").row, s = loadChainBody("elephant").bones, v = loadChainBody("wolf").bones;
  assert.deepEqual(Object.keys(s.bones), Object.keys(v.bones));
  for (const k of Object.keys(s.bones)) assert.deepEqual(s.bones[k].pos, v.bones[k].pos, `${k}: both GLBs share one skeleton`);
  assert.ok(e.total_mass_kg > 10 * w.total_mass_kg, `elephant ${e.total_mass_kg} kg vs wolf ${w.total_mass_kg} kg`);
  const leg = (row, id) => row.roles.find((r) => r.id === id);
  assert.ok(leg(e, "hind_up_L").radius_m > 2 * leg(w, "hind_up_L").radius_m, "elephant legs are thicker");
  // elephant legs are columns (narrower swing than the wolf's), the wolf's lower leg folds further
  assert.ok(leg(e, "hind_up_L").joint.swing_deg < leg(w, "hind_up_L").joint.swing_deg, "elephant leg swing is narrower");
  assert.ok(leg(e, "hind_low_L").joint.hinge_max_deg < leg(w, "hind_low_L").joint.hinge_max_deg, "elephant knee folds less");
  // legs are long: upper + lower reach at least 55% of the standing height in both
  for (const row of [e, w]) assert.ok((leg(row, "front_up_L").length_m + leg(row, "front_low_L").length_m) / row.height_m > 0.55, `${row.body}: legs`);
  assert.deepEqual(e.hinge_flex_z, w.hinge_flex_z);
});

test("elephant: hips and chest are a real barrel, radius at least 0.11 model units (0.55 m at scale 5), never a thin stick on wide legs", () => {
  const spec = read("elephant.chain.json"), row = loadChainBody("elephant").row;
  for (const id of ["hips", "chest"]) {
    assert.ok(spec.segments.find((s) => s.id === id).radius >= 0.11, `${id} spec radius`);
    assert.ok(row.roles.find((r) => r.id === id).radius_m >= 0.55 - 1e-6, `${id} row radius_m`);
  }
});

test("budget rows: eel, elephant and wolf each have a chain set of 7, with tail-cut and chest-hit maps", () => {
  for (const name of NAMES) {
    const set = rows.sets.find((s) => s.id === `${name}_x7`);
    assert.ok(set, `${name}_x7 set`);
    assert.equal(set.kind, "chain");
    assert.deepEqual(set.bodies, Array(7).fill(name));
    assert.equal(set.unit_map.arm_right, "tail");
    assert.equal(set.part_map.spine2, "chest" in WANT[name].map ? "chest" : "chest_a");
    assert.deepEqual(set.scenarios, ["alive_idle", "alive_one_cut", "alive_all_cut", "dying_all_cut"]);
    assert.ok(set.note && set.impulse_scale > 0, "each set says how its hit impulse is scaled to the body's mass");
  }
});

test("budget run: 1 and 3 bodies of each new set give finite timings, the cuts land, and the hash repeats", async () => {
  const res = await runBudget(rows, { counts: [1, 3], repeats: 2, ticks: 100, warm_ticks: 10, sets: NAMES.map((n) => `${n}_x7`) });
  assert.equal(res.cells.length, 3 * 2 * 4);
  for (const c of res.cells) {
    assert.ok(Number.isFinite(c.avg_ms) && c.avg_ms > 0 && c.max_ms >= c.p95_ms, `${c.set} ${c.scenario} n=${c.n}`);
    assert.equal(c.deterministic, true, `${c.set} ${c.scenario} n=${c.n} hash repeats`);
  }
  const cell = (set, sc, n) => res.cells.find((c) => c.set === set && c.scenario === sc && c.n === n);
  for (const name of NAMES) {
    assert.equal(cell(`${name}_x7`, "alive_idle", 3).cuts, 0);
    assert.equal(cell(`${name}_x7`, "alive_one_cut", 3).cuts, 1);
    assert.equal(cell(`${name}_x7`, "alive_all_cut", 3).cuts, 3);
    assert.equal(cell(`${name}_x7`, "dying_all_cut", 3).cuts, 3);
  }
});

test("budget tool: a set's impulse_scale multiplies the scenario's kill impulse (a 2 kg eel is not hit like a 140 kg boss)", async () => {
  const set = rows.sets.find((s) => s.id === "eel_x7");
  const small = { counts: [1], repeats: 1, ticks: 100, warm_ticks: 10, scenarios: ["dying_all_cut"] };
  const a = await runBudget({ ...rows, sets: [set] }, small), b = await runBudget({ ...rows, sets: [{ ...set, impulse_scale: set.impulse_scale * 50 }] }, small);
  assert.notEqual(a.cells[0].hash, b.cells[0].hash, "a different impulse gives a different world");
});
