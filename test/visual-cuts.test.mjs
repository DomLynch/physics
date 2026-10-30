// Visual-only units head_split and belly_open (docs/CUT-CONTRACT.md Optional cuts, docs/API.md): known to the package, cut with rd.cut, nothing detaches,
// no mass moves, the cut rig shows their caps from a manifest written the way tools/cut-units.mjs --head-split --belly-open writes it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { createPhysics } from "../src/index.mjs";
import { createCutRig } from "../src/three-cuts.mjs";

const body = JSON.parse(readFileSync(new URL("../data/bodies/minotaur-106.measure.json", import.meta.url), "utf8"));
const TABLE = JSON.parse(readFileSync(new URL("../data/ragdoll-role-table.json", import.meta.url), "utf8"));
const VISUAL = ["head_split", "belly_open"];
const SIX = ["head", "arm_left", "arm_right", "leg_left", "leg_right", "torso_waist"];
const DETACHING = [...SIX, "hand_left", "hand_right", "foot_left", "foot_right"]; // hands and feet are severable too (test/hands-feet.test.mjs)
const TICK = 1 / 60;

// regions and caps exactly as the cut tool writes them with both flags on (piece_head replaced by its halves, extra belly cap)
const REGIONS = [
  { id: "root", mesh: "piece_root", detached_by: null }, { id: "upper_torso", mesh: "piece_upper_torso", detached_by: "torso_waist" },
  { id: "head_left", mesh: "piece_head_left", detached_by: "head", separated_by: "head_split" }, { id: "head_right", mesh: "piece_head_right", detached_by: "head", separated_by: "head_split" },
  { id: "arm_left", mesh: "piece_arm_left", detached_by: "arm_left" }, { id: "arm_right", mesh: "piece_arm_right", detached_by: "arm_right" },
  { id: "leg_left", mesh: "piece_leg_left", detached_by: "leg_left" }, { id: "leg_right", mesh: "piece_leg_right", detached_by: "leg_right" },
];
const CAPS = [
  ["cap_neck_head_left", "head_left", "head"], ["cap_neck_head_right", "head_right", "head"], ["cap_neck_torso", "upper_torso", "head"],
  ["cap_split_head_left", "head_left", "head_split"], ["cap_split_head_right", "head_right", "head_split"],
  ["cap_belly_opening", "upper_torso", "belly_open"],
  ["cap_shoulder_left_arm", "arm_left", "arm_left"], ["cap_shoulder_left_torso", "upper_torso", "arm_left"],
  ["cap_shoulder_right_arm", "arm_right", "arm_right"], ["cap_shoulder_right_torso", "upper_torso", "arm_right"],
  ["cap_hip_left_leg", "leg_left", "leg_left"], ["cap_hip_left_root", "root", "leg_left"],
  ["cap_hip_right_leg", "leg_right", "leg_right"], ["cap_hip_right_root", "root", "leg_right"],
  ["cap_waist_torso", "upper_torso", "torso_waist"], ["cap_waist_root", "root", "torso_waist"],
];
const manifest = () => ({
  schema: "cut-pieces/1", body: "synthetic", rig: "mixamo-106", source: "synthetic",
  regions: REGIONS.map((r) => ({ ...r })),
  caps: CAPS.map(([id, region, unit]) => ({ id, mesh: id, region, shown_when_cut: unit, ...(id === "cap_belly_opening" ? { kind: "opening" } : {}) })),
});
function scene() {
  const s = new THREE.Scene(), mat = new THREE.MeshStandardMaterial({ name: "cap_flesh" });
  for (const r of REGIONS) { const o = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()); o.name = r.mesh; s.add(o); }
  for (const [id] of CAPS) { const o = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat); o.name = id; s.add(o); }
  return s;
}
const shown = (cr) => Object.keys(cr.caps).filter((k) => cr.caps[k].visible).sort();
const pair = (unit) => CAPS.filter((c) => c[2] === unit).map((c) => c[0]).sort();
const run = (p, n) => { for (let i = 0; i < n; i++) p.step(TICK); };

test("the role table and rd.row.severable list the two visual-only units as rows, the six old units are unchanged", async () => {
  const p = await createPhysics({ seed: 1 }), rd = p.createRagdoll(body);
  assert.deepEqual(rd.row.severable.map((s) => s.id), [...DETACHING, ...VISUAL]);
  assert.deepEqual(TABLE.severable.units.map((u) => u.id), [...DETACHING, ...VISUAL]);
  for (const id of VISUAL) {
    const u = rd.row.severable.find((s) => s.id === id);
    assert.equal(u.visual_only, true); assert.equal(u.cut_role, null); assert.equal(u.joint, null); assert.equal(u.mass_kg, 0); assert.deepEqual(u.carries_roles, []);
    assert.ok(rd.partIds.includes(u.cap_role));
  }
  for (const id of DETACHING) {
    const u = rd.row.severable.find((s) => s.id === id);
    assert.equal(u.visual_only, undefined); assert.ok(u.cut_role && u.joint && u.mass_kg > 0);
  }
  p.destroy();
});

test("a pre-generated ragdoll-row/2 without the visual units gets them from the role table; the row passed in is not changed", async () => {
  const p = await createPhysics({ seed: 1 }), full = p.createRagdoll(body).row;
  const old = { ...full, severable: full.severable.filter((s) => SIX.includes(s.id)) };
  const rd = p.createRagdoll(old);
  assert.deepEqual(rd.row.severable.map((s) => s.id), [...DETACHING, ...VISUAL]);
  assert.equal(old.severable.length, 6);
  assert.ok(rd.cut("belly_open"));
  p.destroy();
});

for (const [unit, part] of [["head_split", "head"], ["belly_open", "spine1"]]) {
  test(`rd.cut(${unit}) succeeds with the usual result shape, detaches nothing and is idempotent`, async () => {
    const p = await createPhysics({ seed: 1 }), rd = p.createRagdoll(body);
    run(p, 30);
    const r = rd.cut(unit);
    assert.equal(r.unit, unit);
    assert.equal(r.visual_only, true);
    assert.equal(r.mass_kg, 0);
    assert.deepEqual(r.carries_roles, []);
    assert.deepEqual(r.props, []);
    assert.equal(r.cap.part, part);
    assert.ok(r.cap.position.length === 3 && r.cap.position.every(Number.isFinite));
    assert.deepEqual(rd.cuts, [unit]);
    assert.equal(rd.cut(unit), null, "second cut is a no-op");
    assert.deepEqual(rd.cuts, [unit]);
    assert.equal(rd.cut(unit, { helmet: true, impulse: [0, 9, 0] }), null);
    p.destroy();
  });
}

test("a visual cut changes nothing in the simulation: same per-tick hash as a run without it, same awake state, body still standing", async () => {
  async function go(visual) {
    const p = await createPhysics({ seed: 5 }), rd = p.createRagdoll(body), hs = [];
    for (let t = 0; t < 120; t++) {
      if (visual && t === 20) { rd.cut("head_split"); rd.cut("belly_open"); }
      if (t === 60) rd.applyImpulse("spine2", [0, 0, 30]);
      p.step(TICK); hs.push(p.hash());
    }
    const out = { hs, state: rd.state, mass: rd.row.total_mass_kg, bodies: rd.partIds.length };
    p.destroy();
    return out;
  }
  const a = await go(false), b = await go(true);
  assert.deepEqual(b.hs, a.hs);
  assert.equal(b.state, "alive"); assert.equal(b.mass, a.mass); assert.equal(b.bodies, a.bodies);
});

test("a visual cut does not end the ragdoll: kill still works, and a visual cut on a frozen corpse works", async () => {
  const p = await createPhysics({ seed: 1 }), rd = p.createRagdoll(body);
  rd.cut("belly_open");
  rd.kill({ part: "spine2", impulse: [0, 0, 40] });
  run(p, 60 * 9);
  assert.equal(rd.state, "frozen");
  assert.ok(rd.cut("head_split"));
  assert.equal(rd.state, "frozen");
  assert.deepEqual(rd.cuts.sort(), ["belly_open", "head_split"]);
  p.destroy();
});

test("head after head_split, and head_split after head, both work and keep both in rd.cuts", async () => {
  for (const order of [["head_split", "head"], ["head", "head_split"]]) {
    const p = await createPhysics({ seed: 1 }), rd = p.createRagdoll(body);
    run(p, 20);
    const results = order.map((u) => rd.cut(u, u === "head" ? { helmet: true } : {}));
    assert.ok(results.every(Boolean), order.join(" then "));
    const head = results[order.indexOf("head")];
    assert.ok(head.mass_kg > 0 && head.carries_roles.includes("head") && head.props.length === 1, "the head cut still detaches the head and pops the helmet");
    assert.deepEqual(rd.cuts.sort(), ["head", "head_split"]);
    run(p, 60);
    const pose = rd.readPose();
    assert.ok([...pose].every(Number.isFinite));
    p.destroy();
  }
});

test("rd.reset() works after visual cuts only (nothing was removed) and hides the caps again; it still refuses after a detaching cut", async () => {
  const p = await createPhysics({ seed: 1 }), rd = p.createRagdoll(body);
  rd.cut("head_split"); rd.cut("belly_open");
  assert.equal(rd.reset(), true);
  assert.deepEqual(rd.cuts, []);
  assert.ok(rd.cut("belly_open"), "can be cut again after the reset");
  rd.cut("arm_left");
  assert.equal(rd.reset(), false);
  p.destroy();
});

test("unknown units still throw", async () => {
  const p = await createPhysics({ seed: 1 }), rd = p.createRagdoll(body);
  assert.throws(() => rd.cut("ear_left"), /unknown severable unit ear_left/);
  p.destroy();
});

async function setup() {
  const p = await createPhysics({ seed: 3 }), rd = p.createRagdoll(body), cr = createCutRig(THREE, rd, scene(), manifest());
  return { p, rd, cr };
}

test("createCutRig loads a manifest with the head halves and the belly cap and shows no cap at the start", async () => {
  const { p, cr } = await setup();
  assert.equal(Object.keys(cr.caps).length, 16);
  assert.equal(Object.keys(cr.pieces).length, 8);
  assert.deepEqual(shown(cr), []);
  p.destroy();
});

test("cutting head_split shows exactly the two cut faces; belly_open shows exactly the belly decal; neither hides or shows a piece", async () => {
  const { p, rd, cr } = await setup();
  rd.cut("head_split"); cr.update();
  assert.deepEqual(shown(cr), ["cap_split_head_left", "cap_split_head_right"]);
  rd.cut("belly_open"); cr.update();
  assert.deepEqual(shown(cr), ["cap_belly_opening", "cap_split_head_left", "cap_split_head_right"]);
  for (const m of Object.values(cr.pieces)) assert.equal(m.visible, true);
  cr.update(); cr.update();
  assert.deepEqual(shown(cr), ["cap_belly_opening", "cap_split_head_left", "cap_split_head_right"]);
  p.destroy();
});

test("head and head_split caps accumulate: the neck caps of both halves plus the cut faces", async () => {
  const { p, rd, cr } = await setup();
  rd.cut("head"); cr.update();
  assert.deepEqual(shown(cr), pair("head"));
  assert.equal(pair("head").length, 3);
  rd.cut("head_split"); cr.update();
  assert.deepEqual(shown(cr), [...pair("head"), ...pair("head_split")].sort());
  p.destroy();
});

test("a manifest naming an unknown unit in detached_by, separated_by or shown_when_cut still fails loudly", async () => {
  const p = await createPhysics({ seed: 3 }), rd = p.createRagdoll(body);
  const a = manifest(); a.regions[2].separated_by = "skull_open";
  assert.throws(() => createCutRig(THREE, rd, scene(), a), /separated by unknown unit "skull_open"/);
  const b = manifest(); b.caps[5].shown_when_cut = "belly_closed";
  assert.throws(() => createCutRig(THREE, rd, scene(), b), /unknown unit "belly_closed"/);
  const c = manifest(); c.regions[2].detached_by = "horn";
  assert.throws(() => createCutRig(THREE, rd, scene(), c), /unknown unit "horn"/);
  p.destroy();
});
