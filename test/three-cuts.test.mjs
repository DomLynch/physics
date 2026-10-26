// three-cuts: caps follow rd.cuts, region meshes stay, unknown manifest names fail loudly. Synthetic scene of plain THREE meshes named per the manifest (no GLB).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { createPhysics } from "../src/index.mjs";
import { createCutRig } from "../src/three-cuts.mjs";

const body = JSON.parse(readFileSync(new URL("../data/bodies/minotaur-106.measure.json", import.meta.url), "utf8"));
const rows = JSON.parse(readFileSync(new URL("../data/cut-caps.json", import.meta.url), "utf8"));

const REGIONS = [["root", null], ["upper_torso", "torso_waist"], ["head", "head"], ["arm_left", "arm_left"], ["arm_right", "arm_right"], ["leg_left", "leg_left"], ["leg_right", "leg_right"]];
const CAPS = [
  ["cap_neck_head", "head", "head"], ["cap_neck_torso", "upper_torso", "head"],
  ["cap_shoulder_left_arm", "arm_left", "arm_left"], ["cap_shoulder_left_torso", "upper_torso", "arm_left"],
  ["cap_shoulder_right_arm", "arm_right", "arm_right"], ["cap_shoulder_right_torso", "upper_torso", "arm_right"],
  ["cap_hip_left_leg", "leg_left", "leg_left"], ["cap_hip_left_root", "root", "leg_left"],
  ["cap_hip_right_leg", "leg_right", "leg_right"], ["cap_hip_right_root", "root", "leg_right"],
  ["cap_waist_torso", "upper_torso", "torso_waist"], ["cap_waist_root", "root", "torso_waist"],
];
const manifest = () => ({
  schema: "cut-pieces/1", body: "synthetic", rig: "mixamo-106", source: "synthetic",
  regions: REGIONS.map(([id, by]) => ({ id, mesh: "piece_" + id, detached_by: by })),
  caps: CAPS.map(([id, region, unit]) => ({ id, mesh: id, region, shown_when_cut: unit })),
});
function scene(skip) {
  const s = new THREE.Scene(), mat = new THREE.MeshStandardMaterial({ name: "cap_flesh" });
  const add = (n, m) => { if (n === skip) return; const o = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), m); o.name = n; s.add(o); };
  for (const [id] of REGIONS) add("piece_" + id, new THREE.MeshStandardMaterial());
  for (const [id] of CAPS) add(id, mat);
  return s;
}
const shown = (cr) => Object.keys(cr.caps).filter((k) => cr.caps[k].visible).sort();
const pair = (unit) => CAPS.filter((c) => c[2] === unit).map((c) => c[0]).sort();

async function setup(skip) {
  const p = await createPhysics({ seed: 3 });
  const rd = p.createRagdoll(body), sc = scene(skip), cr = createCutRig(THREE, rd, sc, manifest());
  return { p, rd, sc, cr };
}

test("caps are hidden at the start, every region is visible", async () => {
  const { p, cr } = await setup();
  assert.equal(Object.keys(cr.caps).length, 12);
  assert.equal(Object.keys(cr.pieces).length, 7);
  assert.deepEqual(shown(cr), []);
  for (const m of Object.values(cr.pieces)) assert.equal(m.visible, true);
  p.destroy();
});

for (const [unit] of [["head"], ["arm_left"], ["arm_right"], ["leg_left"], ["leg_right"], ["torso_waist"]]) {
  test(`cut(${unit}) shows exactly its two caps`, async () => {
    const { p, rd, cr } = await setup();
    assert.ok(rd.cut(unit));
    cr.update();
    assert.deepEqual(shown(cr), pair(unit));
    assert.equal(pair(unit).length, 2);
    for (const m of Object.values(cr.pieces)) assert.equal(m.visible, true);
    p.destroy();
  });
}

test("head, then a second unit: caps accumulate; cutting an already cut unit is a no-op", async () => {
  const { p, rd, cr } = await setup();
  rd.cut("head");
  assert.equal(rd.cut("head"), null);
  cr.update(); cr.update();
  assert.deepEqual(shown(cr), pair("head"));
  rd.cut("arm_left");
  cr.update();
  assert.deepEqual(shown(cr), [...pair("head"), ...pair("arm_left")].sort());
  p.destroy();
});

test("a fresh or reset ragdoll (empty rd.cuts) hides all caps again", async () => {
  const { p, rd, cr } = await setup();
  rd.cut("torso_waist");
  cr.update();
  assert.equal(shown(cr).length, 2);
  // rd.reset() refuses after a cut (the joint is gone); a recreated ragdoll has an empty cut set and the rig follows it
  assert.equal(rd.reset(), false);
  const fake = { cuts: [], row: rd.row };
  const cr2 = createCutRig(THREE, fake, scene(), manifest());
  fake.cuts = ["head"]; cr2.update();
  assert.deepEqual(shown(cr2), pair("head"));
  fake.cuts = []; cr2.update();
  assert.deepEqual(shown(cr2), []);
  p.destroy();
});

test("a ragdoll reset before any cut keeps caps hidden", async () => {
  const { p, rd, cr } = await setup();
  assert.equal(rd.reset(), true);
  cr.update();
  assert.deepEqual(shown(cr), []);
  p.destroy();
});

test("unknown manifest names fail loudly", async () => {
  const p = await createPhysics({ seed: 3 }), rd = p.createRagdoll(body);
  assert.throws(() => createCutRig(THREE, rd, scene("cap_neck_head"), manifest()), /cap "cap_neck_head" mesh "cap_neck_head" is not in the scene/);
  assert.throws(() => createCutRig(THREE, rd, scene("piece_head"), manifest()), /region "head" mesh "piece_head" is not in the scene/);
  const badUnit = manifest(); badUnit.caps[0].shown_when_cut = "ear_left";
  assert.throws(() => createCutRig(THREE, rd, scene(), badUnit), /unknown unit "ear_left"/);
  const badRegion = manifest(); badRegion.caps[1].region = "tail";
  assert.throws(() => createCutRig(THREE, rd, scene(), badRegion), /unknown region "tail"/);
  const badSchema = manifest(); badSchema.schema = "cut-pieces/9";
  assert.throws(() => createCutRig(THREE, rd, scene(), badSchema), /schema/);
  p.destroy();
});

test("data/cut-caps.json: every row has a named source; setCapMaterial sets the cap colours, blood mixes in", async () => {
  for (const k of ["flesh", "inner", "blood"]) assert.ok(rows[k].source && rows[k].source.length > 10, k + " has no source");
  const { p, cr, sc } = await setup();
  const mat = sc.getObjectByName("cap_neck_head").material;
  cr.setCapMaterial({ flesh: { color: "#ff0000" } });
  assert.equal(mat.color.getHexString(), "ff0000");
  cr.setCapMaterial({ flesh: { color: "#ff0000" }, blood: { tint: "#000000", amount: 0.5 } });
  assert.ok(Math.abs(mat.color.r - 0.5) < 1e-6 && mat.color.g === 0);
  cr.setCapMaterial(rows);
  assert.ok(mat.color.r > 0.1 && mat.color.r < 1);
  p.destroy();
});
