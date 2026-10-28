// Chain ragdoll body kind (src/chain.mjs) and its first creature, the salamander (31-bone quadruped rig): the spec validates, the built ragdoll-row/2 makes a
// ragdoll that stands, dies, falls and settles, the run is deterministic, and the humanoid rows are untouched by the row-driven hinge lookup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as pkg from "../src/index.mjs";
import { createPhysics, buildChainRow, loadChainBody, chainBoneMap, chainBoneObjects, chainBodyNames, validateChainSpec } from "../src/index.mjs";
const { chainFollowMap, chainVirtualParts, chainFollowObjects } = pkg; // the roach rig's driven-or-virtual parts and follower bones (looked up by name so a missing export fails one test, not the file)
import { buildDefinition } from "../src/engine.mjs";
import { segSegDist } from "../src/generate.mjs";
import { qmul, qconj } from "../src/math.mjs";

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

// ---- the rat rig family: rat king (mini-boss) and crow, both on the 24-bone rat rig (root > pelvis > spine > chest > neck > head > jaw > bite_tip; tail_1..4; leg_B*/leg_F* > shin > paw) ----
const RIG = {
  "rat-king": { scale: 6, mass: [150, 500], impulse: 320, species: "rat king" }, // x6 in the game (PR #435); masses cubed from the old x3 row (37 kg x 8)
  crow: { scale: 4, mass: [2, 20], impulse: 10, species: "crow" },
};
const EXPECTED_MAP = {
  hips: "pelvis", chest: "chest", head: "neck", tail_a: "tail_1", tail_b: "tail_3",
  leg_BL_up: "leg_BL", leg_BL_low: "shin_BL", leg_BR_up: "leg_BR", leg_BR_low: "shin_BR",
  leg_FL_up: "leg_FL", leg_FL_low: "shin_FL", leg_FR_up: "leg_FR", leg_FR_low: "shin_FR",
};

for (const [name, cfg] of Object.entries(RIG)) {
  const rspec = read(`${name}.chain.json`), rbones = read(`${name}.bones.json`);

  test(`${name} spec: 13 capsules on the rat rig, parent-first, placeholder-marked, scale from Armagedom's model scale, mass plausible`, () => {
    assert.equal(rspec.schema, "chain-body/1");
    assert.equal(rspec.name, name);
    assert.equal(rspec.segments.length, 13);
    assert.equal(rspec.scale, cfg.scale);
    assert.equal(rspec.placeholder, true);
    assert.deepEqual(validateChainSpec(rspec, rbones), []);
    const total = rspec.segments.reduce((a, s) => a + s.mass, 0);
    assert.ok(total > cfg.mass[0] && total < cfg.mass[1], `${name}: total mass ${total} kg is not plausible for a ${cfg.species}`);
    assert.equal(Object.keys(rbones.bones).length, 24, "the rat rig has 24 bones");
    for (const b of ["root", "pelvis", "spine", "chest", "neck", "head", "jaw", "bite_tip", "tail_1", "tail_2", "tail_3", "tail_4", "leg_BL", "shin_BL", "paw_BL", "leg_FR", "shin_FR", "paw_FR"]) assert.ok(rbones.bones[b], `${name}.bones.json: ${b}`);
  });

  test(`${name}: boneMap is the pinned part -> bone table, and every bone with no body follows an owning bone in the scene graph`, () => {
    const body = loadChainBody(name);
    assert.deepEqual(body.boneMap, EXPECTED_MAP);
    assert.deepEqual(chainBoneMap(rspec), EXPECTED_MAP);
    assert.equal(body.row.bodies, 13);
    assert.equal(body.row.kind, "chain");
    assert.equal(body.row.body, name);
    const owned = new Set(Object.values(EXPECTED_MAP));
    for (const b of Object.keys(rbones.bones)) {
      let cur = b;
      while (!owned.has(cur) && rbones.bones[cur].parent) cur = rbones.bones[cur].parent;
      assert.ok(owned.has(cur) || cur === "root", `${name}: bone ${b} has no owning body`);
    }
  });

  test(`${name}: lower legs are hinges that flex the same way (+1 for hind and front: the joint point backward), the tail is the severable unit`, () => {
    const body = loadChainBody(name);
    assert.deepEqual(body.row.hinge_flex_z, { leg_lower_hind: 1, leg_lower_front: 1 });
    for (const id of ["leg_BL_low", "leg_BR_low", "leg_FL_low", "leg_FR_low"]) {
      const r = body.row.roles.find((x) => x.id === id);
      assert.equal(r.joint.type, "hinge", id);
      assert.ok(r.joint.hinge_min_deg < r.joint.hinge_max_deg, id);
    }
    assert.deepEqual(body.row.severable.map((s) => s.id), ["tail"]);
    assert.deepEqual(body.spec.severable[0].carries_roles, ["tail_a", "tail_b"]);
  });

  test(`${name}: the built row has capsules sized to the creature (scale ${cfg.scale}) and every pivot above the floor`, () => {
    const { row } = loadChainBody(name);
    assert.ok(row.height_m > 0.2 && row.height_m < 0.34 * cfg.scale, `height ${row.height_m} m`);
    for (const r of row.roles) {
      assert.ok(r.radius_m > 0.005 && r.radius_m < 0.07 * cfg.scale, `${r.id}: radius ${r.radius_m}`);
      assert.ok(r.rest.pivot[1] > 0, `${r.id}: pivot above the floor`);
    }
  });

  test(`${name}: holds its rest pose with the hips kinematic, then a kill with a hit impulse falls, settles and freezes (no NaN, nothing below the floor)`, async () => {
    const p = await createPhysics({ seed: 1 });
    const rd = p.createRagdoll(loadChainBody(name).row, { id: "r" });
    const p0 = Float32Array.from(rd.readPose());
    for (let t = 0; t < 120; t++) p.step(1 / 60);
    let worst = 0;
    const p1 = rd.readPose();
    for (let i = 0; i < 13; i++) worst = Math.max(worst, Math.hypot(p1[i * 10] - p0[i * 10], p1[i * 10 + 1] - p0[i * 10 + 1], p1[i * 10 + 2] - p0[i * 10 + 2]));
    assert.ok(worst < 0.05 * cfg.scale, `${name}: a part drifted ${worst} m while alive`);
    const hipsY0 = rd.readPose()[1];
    rd.kill({ part: "chest", impulse: [0, 0, cfg.impulse] });
    for (let t = 0; t < 900; t++) p.step(1 / 60);
    const pose = rd.readPose();
    for (const v of pose) assert.ok(Number.isFinite(v), "NaN or Infinity in the pose");
    assert.ok(pose[1] < hipsY0 - 0.03, `${name}: hips at ${pose[1]} m, start ${hipsY0} m`);
    let maxSpeed = 0, minY = Infinity;
    for (let i = 0; i < 13; i++) { maxSpeed = Math.max(maxSpeed, Math.hypot(pose[i * 10 + 7], pose[i * 10 + 8], pose[i * 10 + 9])); minY = Math.min(minY, pose[i * 10 + 1]); }
    assert.ok(maxSpeed < 0.2, `${name}: still moving at ${maxSpeed} m/s after 15 s`);
    assert.ok(minY > -0.02, `${name}: a part is below the floor: y ${minY}`);
    assert.equal(rd.state, "frozen");
    p.destroy();
  });

  test(`${name}: a tail cut frees tail_a and tail_b, and two runs with the same inputs give the same per-tick hash`, async () => {
    const run = async () => {
      const p = await createPhysics({ seed: 3 });
      const rd = p.createRagdoll(loadChainBody(name).row, { id: "r" });
      const hashes = [];
      for (let t = 0; t < 300; t++) {
        if (t === 40) { const c = rd.cut("tail"); assert.deepEqual(c.carries_roles, ["tail_a", "tail_b"]); assert.equal(rd.cut("tail"), null); }
        if (t === 60) rd.kill({ part: "chest", impulse: [cfg.impulse / 3, 2, cfg.impulse] });
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

test("the crow is the lighter one and the rat king the heavier; no crow capsule is fatter in metres (except the wing bones); both GLBs share the same 24-bone skeleton", () => {
  const rat = read("rat-king.chain.json"), crow = read("crow.chain.json");
  const mass = (s) => s.segments.reduce((a, x) => a + x.mass, 0);
  assert.ok(mass(crow) < mass(rat), `crow ${mass(crow)} kg vs rat king ${mass(rat)} kg`);
  // metres, not model units: the king is x6 and the crow x4. The crow's front uppers carry the wing skin (game radius about 0.09), so they may be fatter than the king's front legs.
  const WING = new Set(["leg_FL_up", "leg_FR_up"]);
  assert.ok(crow.segments.every((s) => WING.has(s.id) || s.radius * crow.scale <= rat.segments.find((x) => x.id === s.id).radius * rat.scale + 1e-9), "crow capsule fatter than the rat king's (metres)");
  assert.deepEqual(read("rat-king.bones.json").bones, read("crow.bones.json").bones);
});

test("budget rows: rat_king_x7 and crow_x7 are chain sets of seven bodies, tail for the arm cut, chest for the spine2 hit, no multi-cut scenario", () => {
  const rows = read("../budget-rows.json");
  for (const [id, body] of [["rat_king_x7", "rat-king"], ["crow_x7", "crow"]]) {
    const set = rows.sets.find((s) => s.id === id);
    assert.ok(set, id);
    assert.equal(set.kind, "chain");
    assert.deepEqual(set.bodies, Array(7).fill(body));
    assert.equal(set.unit_map.arm_right, "tail");
    assert.equal(set.part_map.spine2, "chest");
    assert.ok(!set.scenarios.includes("dying_multi_cut"));
  }
});

// ---- the roach rig family: spider (27 bones) and giant centipede (75 bones, ONE rigid 'body' bone, no spine). Both are chain bodies; numbers are placeholders.
const ROACH = {
  spider: {
    parts: 14, kg: [20, 120], legRoots: 6, virtual: [], driven: ["body", "thorax", "head", "abdomen"],
    kill: { part: "body", impulse: [0, 0, 80] }, knock: { part: "thorax", impulse: [90, 70, 0] }, unit: "leg_front_R", carries: ["leg0R_up", "leg0R_low"], cutPart: "thorax",
  },
  centipede: {
    parts: 19, kg: [8, 80], legRoots: 22, virtual: ["seg1", "seg4", "seg6"], driven: ["body", "thorax", "head", "abdomen"],
    kill: { part: "seg3", impulse: [0, 0, 50] }, knock: { part: "seg2", impulse: [50, 40, 0] }, unit: "tail", carries: ["seg5", "seg6", "bank5L", "bank5R", "bank6L", "bank6R"], cutPart: "seg3",
  },
};
const roachSpec = (n) => read(`${n}.chain.json`), roachBones = (n) => read(`${n}.bones.json`);

for (const name of Object.keys(ROACH)) {
  const X = ROACH[name];

  test(`${name}: spec validates, parent-first, ${X.parts} parts, placeholder numbers marked, plausible total mass, scale 3 (Armagedom model scale)`, () => {
    const spec = roachSpec(name), bones = roachBones(name);
    assert.equal(spec.schema, "chain-body/1");
    assert.equal(spec.name, name);
    assert.equal(spec.segments.length, X.parts);
    assert.equal(spec.placeholder, true);
    assert.ok(spec.placeholder_note && spec.mass_assumption && spec.scale_source && spec.about);
    assert.equal(spec.scale, 3);
    assert.deepEqual(validateChainSpec(spec, bones), []);
    const total = spec.segments.reduce((a, s) => a + s.mass, 0);
    assert.ok(total > X.kg[0] && total < X.kg[1], `${total} kg`);
    for (const s of spec.segments) assert.ok(s.source, `${s.id}: every number names where it came from`);
    assert.equal(spec.segments[0].parent, null);
  });

  test(`${name}: bones file = the GLB node positions (real bones) plus flagged synthetic anchors only`, () => {
    const bones = roachBones(name);
    assert.equal(bones.schema, "chain-bones/1");
    assert.equal(bones.body, name);
    const real = Object.entries(bones.bones).filter(([, b]) => !b.synthetic), synth = Object.entries(bones.bones).filter(([, b]) => b.synthetic);
    assert.equal(real.length, name === "spider" ? 27 : 75, "every skin joint of the GLB");
    for (const [k, b] of synth) assert.ok(b.note && b.pos.length === 3, `synthetic ${k} says why`);
    for (const [k, b] of real) assert.ok(b.pos.length === 3 && b.pos.every(Number.isFinite) && (b.parent === null || bones.bones[b.parent]), k);
    assert.equal(bones.bones.root.parent, null);
    assert.equal(bones.bones.body.parent, "root");
  });

  test(`${name}: boneMap, followers and virtual parts: no bone is driven or followed twice, every leg root is covered once`, () => {
    const spec = roachSpec(name), bones = roachBones(name);
    const map = chainBoneMap(spec), follow = chainFollowMap(spec), virt = chainVirtualParts(spec);
    assert.deepEqual(virt, X.virtual);
    assert.equal(Object.keys(map).length + virt.length, X.parts);
    for (const v of virt) assert.ok(!(v in map), `${v} is virtual: no bone`);
    for (const [part, bone] of Object.entries(map)) assert.ok(bones.bones[bone] && !bones.bones[bone].synthetic, `${part} -> ${bone} is a real bone`);
    const all = [...Object.values(map), ...Object.values(follow).flat()];
    assert.equal(new Set(all).size, all.length, "a bone is driven or followed by one part only");
    for (const b of X.driven) assert.ok(Object.values(map).includes(b) || all.includes(b), `${b} moves with the ragdoll`);
    const legRoots = Object.keys(bones.bones).filter((b) => /^leg_/.test(b));
    assert.equal(legRoots.length, X.legRoots);
    for (const b of legRoots) assert.equal(all.filter((x) => x === b).length, 1, `leg bone ${b} is driven or followed exactly once`);
    const body = loadChainBody(name);
    assert.deepEqual(body.boneMap, map);
    assert.deepEqual(body.followMap, follow);
    assert.deepEqual(body.virtualParts, virt);
    assert.ok(chainBodyNames().includes(name));
  });

  test(`${name}: chainBoneObjects hands the game an Object3D for each driven part and refuses a model missing one`, () => {
    const spec = roachSpec(name), map = chainBoneMap(spec);
    const objs = chainBoneObjects(spec, (n) => ({ name: n }));
    assert.deepEqual(Object.keys(objs), Object.keys(map));
    for (const [part, o] of Object.entries(objs)) assert.equal(o.name, map[part]);
    assert.throws(() => chainBoneObjects(spec, (n) => (n === "head" ? null : { name: n })), /head/);
    const f = chainFollowObjects(spec, (n) => ({ name: n }));
    assert.deepEqual(Object.keys(f), Object.keys(chainFollowMap(spec)));
  });

  test(`${name}: row builds, rest pose has no overlapping capsules except parent and child (else the spawn explodes)`, () => {
    const spec = roachSpec(name), row = buildChainRow(spec, roachBones(name));
    assert.equal(row.roles.length, X.parts);
    assert.equal(row.kind, "chain");
    const ends = row.roles.map((r) => ({ a: r.rest.pivot, b: [0, 1, 2].map((k) => r.rest.pivot[k] + r.rest.dir[k] * r.length_m), r: r.radius_m }));
    const idx = Object.fromEntries(row.roles.map((r, i) => [r.id, i]));
    let worst = Infinity, who = "";
    for (let i = 0; i < ends.length; i++) for (let j = i + 1; j < ends.length; j++) {
      if (row.roles[i].parent === row.roles[j].id || row.roles[j].parent === row.roles[i].id) continue;
      const gap = segSegDist(ends[i].a, ends[i].b, ends[j].a, ends[j].b) - ends[i].r - ends[j].r;
      if (gap < worst) { worst = gap; who = `${row.roles[i].id}/${row.roles[j].id}`; }
    }
    assert.ok(worst > -0.002, `${who} overlap by ${-worst} m at rest`);
    for (const r of row.roles) assert.ok(r.half_height_m >= 0.01 && r.radius_m > 0 && r.mass_kg > 0 && Number.isFinite(r.reach_m), r.id);
    assert.ok(idx[X.unit] === undefined, "a severable unit id is not a part id");
    assert.ok(row.height_m > 0.1 && row.height_m < 2, `height ${row.height_m} m`);
  });

  test(`${name}: createRagdoll makes ${X.parts} bodies and holds its rest pose with the root kinematic`, async () => {
    const p = await createPhysics({ seed: 1 });
    const rd = p.createRagdoll(loadChainBody(name).row, { id: name });
    assert.equal(rd.partIds.length, X.parts);
    assert.equal(rd.readPose().length, X.parts * 10);
    const p0 = Float32Array.from(rd.readPose());
    for (let t = 0; t < 120; t++) p.step(1 / 60);
    const p1 = rd.readPose();
    let worst = 0;
    for (let i = 0; i < X.parts; i++) worst = Math.max(worst, Math.hypot(p1[i * 10] - p0[i * 10], p1[i * 10 + 1] - p0[i * 10 + 1], p1[i * 10 + 2] - p0[i * 10 + 2]));
    for (const v of p1) assert.ok(Number.isFinite(v));
    assert.ok(worst < 0.25, `a part drifted ${worst} m`);
    p.destroy();
  });

  for (const [hit, how] of [["pushed", X.kill], ["knocked", X.knock]]) test(`${name}: killed ${hit}: it flops (distances between parts change), settles, freezes on the floor, no NaN`, async () => {
    const p = await createPhysics({ seed: 1 });
    const rd = p.createRagdoll(loadChainBody(name).row, { id: name });
    for (let t = 0; t < 30; t++) p.step(1 / 60);
    const p0 = Float32Array.from(rd.readPose());
    rd.kill(how);
    for (let t = 0; t < 1500; t++) p.step(1 / 60);
    const pose = rd.readPose();
    for (const v of pose) assert.ok(Number.isFinite(v), "NaN or Infinity in the pose");
    let maxSpeed = 0, minY = Infinity, shape = 0, bend = 0;
    const dist = (q, i) => Math.hypot(q[i * 10] - q[0], q[i * 10 + 1] - q[1], q[i * 10 + 2] - q[2]);
    for (let i = 0; i < X.parts; i++) {
      maxSpeed = Math.max(maxSpeed, Math.hypot(pose[i * 10 + 7], pose[i * 10 + 8], pose[i * 10 + 9]));
      minY = Math.min(minY, pose[i * 10 + 1]);
      shape = Math.max(shape, Math.abs(dist(pose, i) - dist(p0, i))); // rotating or sliding the whole creature does not count, only a part moving relative to the root part
      // how far each part turned relative to the root part (a leg folding or a segment bending), in degrees
      const rel = (q) => qmul(qconj([q[3], q[4], q[5], q[6]]), [q[i * 10 + 3], q[i * 10 + 4], q[i * 10 + 5], q[i * 10 + 6]]), a = rel(p0), b = rel(pose);
      bend = Math.max(bend, 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * 180 / Math.PI);
    }
    const m = JSON.stringify({ bendDeg: +bend.toFixed(1), shape: +shape.toFixed(3), rootDy: +(pose[1] - p0[1]).toFixed(3), maxSpeed: +maxSpeed.toFixed(3), minY: +minY.toFixed(3), state: rd.state });
    // measured on the first run: 12 to 25 degrees. These creatures rest almost on the floor (the spider's body bottom is 4 cm up, its feet 3 cm), so a limp ragdoll
    // sags about 5 cm and its legs fold 12 to 25 degrees; a deeper curl has to come from the death clip used as the motor target during the ramp, not from gravity.
    assert.ok(bend > 10, `no part turned relative to the root: the body kept its rest shape ${m}`);
    assert.ok(pose[1] < p0[1] - 0.02, `the root part did not sink ${m}`);
    assert.ok(maxSpeed < 0.2, `still moving after 25 s ${m}`);
    assert.ok(minY > -0.02, `a part is below the floor ${m}`);
    assert.equal(rd.state, "frozen", m);
    p.destroy();
  });

  test(`${name}: cutting ${X.unit} frees its parts only`, async () => {
    const p = await createPhysics({ seed: 1 });
    const rd = p.createRagdoll(loadChainBody(name).row, { id: name });
    const r = rd.cut(X.unit);
    assert.equal(r.unit, X.unit);
    assert.deepEqual(r.carries_roles, X.carries);
    assert.ok(r.mass_kg > 0);
    assert.equal(rd.cut(X.unit), null);
    for (let t = 0; t < 60; t++) p.step(1 / 60);
    for (const v of rd.readPose()) assert.ok(Number.isFinite(v));
    assert.throws(() => rd.cut("head_split"), /unknown severable unit/);
    p.destroy();
  });

  test(`${name}: deterministic, same inputs give the same per-tick hash`, async () => {
    const run = async () => {
      const p = await createPhysics({ seed: 3 });
      const rd = p.createRagdoll(loadChainBody(name).row, { id: name });
      const hashes = [];
      for (let t = 0; t < 300; t++) {
        if (t === 40) rd.cut(X.unit);
        if (t === 60) rd.kill({ part: X.kill.part, impulse: [X.kill.impulse[2] / 10, 2, X.kill.impulse[2]] });
        p.step(1 / 60);
        hashes.push(p.hash());
      }
      p.destroy();
      return hashes;
    };
    const a = await run(), b = await run();
    assert.deepEqual(a, b);
    assert.notEqual(a[0], a[299]);
  });

  test(`${name}: budget set ${name}_x7 is a chain set of 7 bodies with a cut mapping`, () => {
    const rows = JSON.parse(readFileSync(new URL("../data/budget-rows.json", import.meta.url), "utf8"));
    const set = rows.sets.find((s) => s.id === `${name}_x7`);
    assert.ok(set, "set row");
    assert.equal(set.kind, "chain");
    assert.deepEqual(set.bodies, Array(7).fill(name));
    assert.equal(set.unit_map.arm_right, X.unit);
    assert.equal(set.part_map.spine2, X.cutPart);
    assert.ok(set.note);
  });
}

test("centipede: the chain runs along the body's long axis, head in front, and each leg pair rides the segment it is under", () => {
  const spec = roachSpec("centipede"), bones = roachBones("centipede"), S = spec.scale, row = buildChainRow(spec, bones);
  const seg = row.roles.filter((r) => /^seg\d$/.test(r.id));
  assert.ok(seg.length >= 6 && seg.length <= 8, `${seg.length} body segments`);
  const span = (r) => { const z0 = r.rest.pivot[2], z1 = z0 + r.rest.dir[2] * r.length_m; return [Math.min(z0, z1), Math.max(z0, z1)]; };
  for (const r of seg) assert.ok(Math.abs(r.rest.dir[2]) > 0.99, `${r.id} lies along z`);
  const spans = seg.map(span).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) assert.ok(spans[i][0] <= spans[i - 1][1] + 1e-3, "segments touch end to end, no gap");
  const legZ = Object.entries(bones.bones).filter(([k]) => /^leg_/.test(k)).map(([, b]) => b.pos[2] * S);
  assert.ok(spans[0][0] <= Math.min(...legZ) + 1e-3 && spans[spans.length - 1][1] >= Math.max(...legZ) - 1e-3, "the chain covers every leg attachment");
  const head = row.roles.find((r) => r.id === "head");
  assert.ok(head.rest.pivot[2] > Math.max(...legZ), "the head is in front of the first leg pair");
  const byId = Object.fromEntries(row.roles.map((r) => [r.id, r]));
  const spans2 = Object.fromEntries(seg.map((r) => [r.id, span(r)]));
  const map = chainBoneMap(spec), follow = chainFollowMap(spec);
  let banks = 0;
  for (const r of row.roles.filter((x) => /^bank/.test(x.id))) {
    banks++;
    const [lo, hi] = spans2[r.parent];
    for (const b of [map[r.id], ...(follow[r.id] || [])]) { const z = bones.bones[b].pos[2] * S; assert.ok(z >= lo - 1e-3 && z <= hi + 1e-3, `${b} (z ${z}) is outside ${r.parent} [${lo}, ${hi}]`); }
    assert.equal(byId[r.id].joint.type, "ball");
  }
  assert.equal(banks, 12, "six leg banks per side count");
  assert.equal(row.roles[0].id, "seg3");
  assert.equal(map.seg3, "body", "the root segment drives the single rigid body bone: every other bone hangs off it");
  assert.equal(map.seg2, "thorax");
  assert.equal(map.seg5, "abdomen");
  assert.equal(map.head, "head");
});

test("spider: six leg roots, each driven by its own part, front and rear legs have two segments, middle legs one", () => {
  const spec = roachSpec("spider"), map = chainBoneMap(spec);
  for (const n of [0, 1, 2]) for (const s of ["L", "R"]) assert.ok(Object.values(map).includes(`leg_${n}${s}`));
  for (const s of ["L", "R"]) { assert.ok(Object.values(map).includes(`shin_0${s}`) && Object.values(map).includes(`shin_2${s}`)); assert.ok(!Object.values(map).includes(`shin_1${s}`)); }
  assert.equal(map.body, "body");
  assert.equal(spec.segments[0].id, "body");
  assert.deepEqual(chainVirtualParts(spec), []);
});

test("validateChainSpec on the new fields: drives/follow must be real bones, no bone twice, a synthetic anchor needs an explicit drives", () => {
  const spec = roachSpec("centipede"), bones = roachBones("centipede");
  const errs = (mutate) => { const s = JSON.parse(JSON.stringify(spec)), b = JSON.parse(JSON.stringify(bones)); mutate(s, b); return validateChainSpec(s, b); };
  assert.ok(errs((s) => { s.segments[1].drives = "no_such_bone"; }).length > 0, "unknown drives");
  assert.ok(errs((s) => { s.segments[1].drives = "axis_f2"; }).length > 0, "drives a synthetic anchor");
  assert.ok(errs((s) => { delete s.segments[1].drives; }).length > 0, "synthetic bone without drives");
  assert.ok(errs((s) => { s.segments.find((x) => x.id === "bank1L").follow = ["leg_c0L"]; }).length > 0, "a bone followed by a part and driven by another");
  assert.ok(errs((s) => { s.segments.find((x) => x.id === "bank1L").follow = "leg_c0R"; }).length > 0, "follow must be an array");
  assert.ok(errs((s) => { s.segments.find((x) => x.id === "bank1L").follow = ["no_such_bone"]; }).length > 0, "unknown follow bone");
  assert.ok(errs((s) => { s.segments.find((x) => x.id === "seg1").drives = "body"; }).length > 0, "two parts drive body");
  assert.deepEqual(errs(() => {}), []);
});
