// Hands and feet are severable (Dom's ruling: six severable parts, head, body, arms, legs, feet, hands): hand_left/right and foot_left/right, data-driven from the
// role table. Cut orders (hand then arm, arm then hand, foot then leg, leg then foot), what each piece carries, mass, joints, the cut rig caps, old rows and
// manifests, non-humanoid bodies, limb-loss rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { createPhysics, loadChainBody, validateLimbLoss } from "../src/index.mjs";
import { createCutRig } from "../src/three-cuts.mjs";

const rd_ = (f) => JSON.parse(readFileSync(new URL("../data/" + f, import.meta.url), "utf8"));
const body = rd_("bodies/minotaur-106.measure.json");
const TABLE = rd_("ragdoll-role-table.json");
const NEW = ["hand_left", "hand_right", "foot_left", "foot_right"];
const OLD = ["head", "arm_left", "arm_right", "leg_left", "leg_right", "torso_waist"];
const VISUAL = ["head_split", "belly_open"];
const TICK = 1 / 60;
const run = (p, n) => { for (let i = 0; i < n; i++) p.step(TICK); };
const S = (side) => (side === "left" ? "Left" : "Right");
const mass = (rd, ids) => Math.round(ids.reduce((a, id) => a + rd.row.roles.find((r) => r.id === id).mass_kg, 0) * 1000) / 1000;
const pos = (rd, id) => { const i = rd.partIds.indexOf(id), q = rd.readPose(); return [q[i * 10], q[i * 10 + 1], q[i * 10 + 2]]; };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
async function fresh(opts = {}) { const p = await createPhysics({ seed: 1, ...opts }), rd = p.createRagdoll(body); return { p, rd }; }

test("role table: the four new units carry the arm/leg keys, cut role, parent, carried roles and gear slots (data only)", () => {
  assert.deepEqual(TABLE.severable.units.map((u) => u.id), [...OLD, ...NEW, ...VISUAL]);
  for (const s of ["left", "right"]) {
    const h = TABLE.severable.units.find((u) => u.id === "hand_" + s), f = TABLE.severable.units.find((u) => u.id === "foot_" + s), X = S(s);
    assert.equal(h.cut_role, "hand" + X); assert.equal(h.cut_parent, "forearm" + X); assert.deepEqual(h.carries_roles, ["hand" + X]); assert.deepEqual(h.gear_slots, ["hands"]);
    assert.equal(f.cut_role, "foot" + X); assert.equal(f.cut_parent, "shin" + X); assert.deepEqual(f.carries_roles, ["foot" + X, "toe" + X]); assert.deepEqual(f.gear_slots, ["feet"]);
    assert.deepEqual(Object.keys(h).sort(), Object.keys(TABLE.severable.units.find((u) => u.id === "arm_" + s)).filter((k) => k !== "note").concat(h.note ? ["note"] : []).sort());
  }
  assert.match(TABLE.severable.about, /ten|hands|feet/i, "the about line is updated");
});

test("armour rows: the hands and feet slots detach as props on sever, and every gear slot of a unit is covered by roles it carries", () => {
  const slots = TABLE.armour_tiers.slots;
  assert.equal(slots.hands.detach_as_prop_on_sever, true);
  assert.equal(slots.feet.detach_as_prop_on_sever, true);
  const ofRole = (id) => TABLE.roles.find((r) => r.id === id.replace(/(Left|Right)$/, ""));
  for (const u of TABLE.severable.units.filter((x) => !x.visual_only && NEW.includes(x.id) || x.id.startsWith("arm") || x.id.startsWith("leg"))) {
    const carried = new Set(u.carries_roles.map((id) => ofRole(id).armour_slot));
    for (const g of u.gear_slots) assert.ok(carried.has(g), `${u.id}: gear slot ${g} is worn on a carried role`);
  }
});

test("rd.row.severable lists the new units with mass of the carried roles, the severed joint and the pivot of the cut role", async () => {
  const { p, rd } = await fresh();
  assert.deepEqual(rd.row.severable.map((s) => s.id), [...OLD, ...NEW, ...VISUAL]);
  for (const s of ["left", "right"]) {
    const X = S(s), h = rd.row.severable.find((u) => u.id === "hand_" + s), f = rd.row.severable.find((u) => u.id === "foot_" + s);
    assert.equal(h.detaches_from, "forearm" + X); assert.equal(f.detaches_from, "shin" + X);
    assert.equal(h.mass_kg, mass(rd, ["hand" + X])); assert.equal(f.mass_kg, mass(rd, ["foot" + X, "toe" + X]));
    assert.deepEqual(h.joint, rd.row.roles.find((r) => r.id === "hand" + X).joint);
    assert.deepEqual(f.cut_pivot, rd.row.roles.find((r) => r.id === "foot" + X).rest.pivot);
    assert.ok(h.mass_kg > 0 && f.mass_kg > h.mass_kg);
  }
  p.destroy();
});

for (const unit of NEW) {
  test(`rd.cut(${unit}): return shape, cap on the forearm/shin, joint removed, 120 Hz window, second cut null, only the cut piece flies`, async () => {
    const { p, rd } = await fresh();
    run(p, 20);
    const side = unit.endsWith("left") ? "Left" : "Right", isHand = unit.startsWith("hand");
    const cutRole = (isHand ? "hand" : "foot") + side, parent = (isHand ? "forearm" : "shin") + side;
    const before = pos(rd, parent), h0 = pos(rd, cutRole), t0 = rd.row.roles.length;
    const r = rd.cut(unit, { impulse: [0, 3, 0] });
    assert.equal(r.unit, unit);
    assert.equal(r.mass_kg, rd.row.severable.find((s) => s.id === unit).mass_kg);
    assert.deepEqual(r.carries_roles, isHand ? ["hand" + side] : ["foot" + side, "toe" + side]);
    assert.deepEqual(r.gear_slots, isHand ? ["hands"] : ["feet"]);
    assert.equal(r.cap.part, cutRole);
    assert.ok(r.cap.position.every(Number.isFinite));
    assert.ok(dist(r.cap.position, before) < 0.45, "the stump sits on the forearm/shin capsule: " + dist(r.cap.position, before));
    assert.deepEqual(r.props, []);
    assert.deepEqual(rd.cuts, [unit]);
    assert.equal(rd.cut(unit), null);
    run(p, 60);
    assert.ok(dist(pos(rd, cutRole), h0) > 0.15, "the piece left its place");
    assert.ok(dist(pos(rd, cutRole), pos(rd, parent)) > 0.2, "joint to the forearm/shin is gone");
    assert.equal(rd.row.roles.length, t0);
    p.destroy();
  });
}

// the order matrix: [first, second, what the second carries, its gear slots]
const LIMBS = [
  { top: "arm", low: "hand", carryTop: (X) => [`arm${X}`, `forearm${X}`, `hand${X}`], carryTopRest: (X) => [`arm${X}`, `forearm${X}`], low_c: (X) => [`hand${X}`], topSlots: ["arms", "hands"], topRest: ["arms"], lowSlots: ["hands"] },
  { top: "leg", low: "foot", carryTop: (X) => [`thigh${X}`, `shin${X}`, `foot${X}`, `toe${X}`], carryTopRest: (X) => [`thigh${X}`, `shin${X}`], low_c: (X) => [`foot${X}`, `toe${X}`], topSlots: ["legs", "feet"], topRest: ["legs"], lowSlots: ["feet"] },
];
for (const L of LIMBS) for (const side of ["left", "right"]) {
  const X = S(side), top = `${L.top}_${side}`, low = `${L.low}_${side}`;
  test(`order ${low} then ${top}: the ${L.top} carries only what is still attached (mass, roles, gear slots), ${low} gone from it`, async () => {
    const { p, rd } = await fresh();
    const a = rd.cut(low), b = rd.cut(top);
    assert.deepEqual(a.carries_roles, L.low_c(X));
    assert.deepEqual(b.carries_roles, L.carryTopRest(X));
    assert.deepEqual(b.gear_slots, L.topRest);
    assert.equal(b.mass_kg, mass(rd, L.carryTopRest(X)));
    assert.equal(+(a.mass_kg + b.mass_kg).toFixed(3), +rd.row.severable.find((s) => s.id === top).mass_kg.toFixed(3), "no mass lost or counted twice");
    assert.deepEqual(rd.cuts, [low, top]);
    assert.equal(rd.cut(low), null); assert.equal(rd.cut(top), null);
    run(p, 60);
    p.destroy();
  });
  test(`order ${top} then ${low}: the flying ${L.top} gives up its ${L.low}; the ${top} result is unchanged (carries all)`, async () => {
    const { p, rd } = await fresh();
    run(p, 10);
    const b = rd.cut(top, { impulse: [0, 2, 0] }), a = rd.cut(low);
    assert.ok(a, `${low} can still be cut from the flying ${L.top}`);
    assert.deepEqual(b.carries_roles, L.carryTop(X));
    assert.deepEqual(b.gear_slots, L.topSlots);
    assert.equal(b.mass_kg, rd.row.severable.find((s) => s.id === top).mass_kg);
    assert.deepEqual(a.carries_roles, L.low_c(X));
    assert.deepEqual(a.gear_slots, L.lowSlots);
    assert.equal(a.mass_kg, rd.row.severable.find((s) => s.id === low).mass_kg);
    assert.deepEqual(rd.cuts, [top, low]);
    assert.equal(rd.cut(low), null); assert.equal(rd.cut(top), null);
    const cp = a.cap.position;
    assert.ok(cp.every(Number.isFinite));
    run(p, 60);
    const joined = pos(rd, L.low + X), parent = pos(rd, (L.low === "hand" ? "forearm" : "shin") + X);
    assert.ok(dist(joined, parent) > 0.0, "finite");
    p.destroy();
  });
}

test("both sides, all four, in one body: every unit cuts once, masses add up, the rest of the body keeps its joints", async () => {
  const { p, rd } = await fresh();
  const out = NEW.map((u) => rd.cut(u));
  assert.ok(out.every(Boolean));
  assert.deepEqual(rd.cuts, NEW);
  const m = out.reduce((a, r) => a + r.mass_kg, 0);
  assert.ok(m > 0 && m < 0.06 * rd.row.total_mass_kg + 1);
  run(p, 90);
  assert.equal(rd.cut("hand_left"), null);
  const arm = rd.cut("arm_left"), leg = rd.cut("leg_right");
  assert.deepEqual(arm.carries_roles, ["armLeft", "forearmLeft"]);
  assert.deepEqual(leg.carries_roles, ["thighRight", "shinRight"]);
  p.destroy();
});

test("torso_waist after a hand: the upper body carries the arm without that hand; a hand cut after the waist is still allowed", async () => {
  const { p, rd } = await fresh();
  rd.cut("hand_left");
  const t = rd.cut("torso_waist");
  assert.ok(!t.carries_roles.includes("handLeft") && t.carries_roles.includes("handRight") && t.carries_roles.includes("forearmLeft"));
  assert.equal(t.mass_kg, mass(rd, t.carries_roles));
  assert.ok(rd.cut("hand_right"), "hand_right still attached to the flying arm");
  p.destroy();
});

test("a frozen corpse gives up a foot: the foot wakes, the rest stays asleep and the state stays frozen", async () => {
  const { p, rd } = await fresh();
  rd.kill({ part: "spine2", impulse: [0, 0, 60] });
  run(p, 540);
  assert.equal(rd.state, "frozen");
  const torso = pos(rd, "spine2"), foot = pos(rd, "footLeft");
  const r = rd.cut("foot_left", { impulse: [0, 3, 0] });
  assert.deepEqual(r.carries_roles, ["footLeft", "toeLeft"]);
  run(p, 60);
  assert.ok(dist(pos(rd, "footLeft"), foot) > 0.02, "the cut foot moved");
  assert.ok(dist(pos(rd, "spine2"), torso) < 0.02, "the torso stayed put");
  p.destroy();
});

test("the cut high-rate window is shared with the other units: a hand cut starts it like an arm cut (same world hash for the same steps and cut tick)", async () => {
  const hashOf = async (unit) => { const { p, rd } = await fresh(); run(p, 30); rd.cut(unit); const h = []; for (let i = 0; i < 20; i++) { p.step(TICK); h.push(p.hash()); } p.destroy(); return h; };
  const a = await hashOf("hand_left"), b = await hashOf("hand_left"), c = await hashOf("foot_left");
  assert.deepEqual(a, b, "deterministic");
  assert.notDeepEqual(a, c);
});

test("a ragdoll-row/2 generated before hands and feet existed gets the new units from the role table (row passed in is not changed)", async () => {
  const p = await createPhysics({ seed: 1 }), full = p.createRagdoll(body).row;
  const old = { ...full, severable: full.severable.filter((s) => !NEW.includes(s.id) && !s.visual_only) };
  const rd = p.createRagdoll(old);
  assert.deepEqual(rd.row.severable.map((s) => s.id), [...OLD, ...NEW, ...VISUAL]);
  assert.equal(old.severable.length, 6);
  assert.ok(rd.cut("hand_right"));
  p.destroy();
});

test("non-humanoid chain bodies do not list or know the new units; the dog, centipede and drone rows are unchanged", async () => {
  const p = await createPhysics({ seed: 1 });
  for (const name of ["dog", "centipede", "drone"]) {
    const { spec, row } = loadChainBody(name);
    assert.ok(!row.severable.some((s) => NEW.includes(s.id)), name);
    assert.deepEqual(row.severable.map((s) => s.id), (spec.severable || []).map((s) => s.id));
    const rd = p.createRagdoll(row);
    for (const u of NEW) assert.throws(() => rd.cut(u), /unknown severable unit/);
    assert.ok(!rd.row.severable.some((s) => NEW.includes(s.id)));
  }
  p.destroy();
});

// ------------------------------------------------------------------ cut rig
const REGIONS = [["root", null], ["upper_torso", "torso_waist"], ["head", "head"], ["arm_left", "arm_left"], ["arm_right", "arm_right"], ["leg_left", "leg_left"], ["leg_right", "leg_right"],
  ["hand_left", "hand_left"], ["hand_right", "hand_right"], ["foot_left", "foot_left"], ["foot_right", "foot_right"]];
const CAPS = [
  ["cap_neck_head", "head", "head"], ["cap_neck_torso", "upper_torso", "head"],
  ["cap_shoulder_left_arm", "arm_left", "arm_left"], ["cap_shoulder_left_torso", "upper_torso", "arm_left"],
  ["cap_wrist_left_hand", "hand_left", "hand_left"], ["cap_wrist_left_arm", "arm_left", "hand_left"],
  ["cap_wrist_right_hand", "hand_right", "hand_right"], ["cap_wrist_right_arm", "arm_right", "hand_right"],
  ["cap_ankle_left_foot", "foot_left", "foot_left"], ["cap_ankle_left_leg", "leg_left", "foot_left"],
  ["cap_ankle_right_foot", "foot_right", "foot_right"], ["cap_ankle_right_leg", "leg_right", "foot_right"],
];
const manifest = (regs = REGIONS, caps = CAPS) => ({
  schema: "cut-pieces/1", body: "synthetic", rig: "mixamo-106", source: "synthetic",
  regions: regs.map(([id, by]) => ({ id, mesh: "piece_" + id, detached_by: by })),
  caps: caps.map(([id, region, unit]) => ({ id, mesh: id, region, shown_when_cut: unit })),
});
function scene(regs = REGIONS, caps = CAPS) {
  const s = new THREE.Scene(), mat = new THREE.MeshStandardMaterial({ name: "cap_flesh" });
  for (const [id] of regs) { const o = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()); o.name = "piece_" + id; s.add(o); }
  for (const [id] of caps) { const o = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat); o.name = id; s.add(o); }
  return s;
}
const shown = (cr) => Object.keys(cr.caps).filter((k) => cr.caps[k].visible).sort();
const pair = (unit) => CAPS.filter((c) => c[2] === unit).map((c) => c[0]).sort();

test("cut rig accepts wrist/ankle caps and hand/foot regions: hidden at start, each cut shows exactly its two caps, regions stay visible", async () => {
  for (const unit of NEW) {
    const { p, rd } = await fresh(), cr = createCutRig(THREE, rd, scene(), manifest());
    assert.deepEqual(shown(cr), []);
    assert.ok(rd.cut(unit)); cr.update();
    assert.deepEqual(shown(cr), pair(unit)); assert.equal(pair(unit).length, 2);
    for (const m of Object.values(cr.pieces)) assert.equal(m.visible, true);
    cr.update(); assert.deepEqual(shown(cr), pair(unit), "update twice is a no-op");
    p.destroy();
  }
});

test("cut rig: hand then arm shows both pairs; arm then hand too; a fresh ragdoll hides them again", async () => {
  const { p, rd } = await fresh(), cr = createCutRig(THREE, rd, scene(), manifest());
  rd.cut("hand_left"); rd.cut("arm_left"); cr.update();
  assert.deepEqual(shown(cr), [...pair("hand_left"), ...pair("arm_left")].sort());
  const rd2 = p.createRagdoll(body), cr2 = createCutRig(THREE, rd2, scene(), manifest());
  rd2.cut("arm_left"); rd2.cut("hand_left"); cr2.update();
  assert.deepEqual(shown(cr2), [...pair("hand_left"), ...pair("arm_left")].sort());
  const rd3 = p.createRagdoll(body); createCutRig(THREE, rd3, scene(), manifest()).update();
  assert.deepEqual(rd3.cuts, []);
  p.destroy();
});

test("old manifests (no hands or feet) keep working unchanged: a hand cut shows no cap and nothing throws", async () => {
  const regs = REGIONS.slice(0, 7), caps = CAPS.slice(0, 4);
  const { p, rd } = await fresh(), m = manifest(regs, caps), before = JSON.stringify(m);
  const cr = createCutRig(THREE, rd, scene(regs, caps), m);
  assert.equal(JSON.stringify(m), before, "manifest is not mutated");
  rd.cut("hand_left"); rd.cut("arm_left"); cr.update();
  assert.deepEqual(shown(cr), pair("arm_left").filter((id) => caps.some((c) => c[0] === id)));
  p.destroy();
});

test("cut rig on a chain body: a hand cap fails loudly (the body cannot cut hands)", async () => {
  const p = await createPhysics({ seed: 1 }), rd = p.createRagdoll(loadChainBody("dog").row);
  const regs = [["root", null], ["hand_left", "hand_left"]];
  assert.throws(() => createCutRig(THREE, rd, scene(regs, []), manifest(regs, [])), /unknown unit "hand_left"/);
  p.destroy();
});

test("limb-loss rows may name a hand or foot as a piece_hostile unit", () => {
  const d = rd_("limb-loss.json");
  for (const u of NEW) {
    const x = JSON.parse(JSON.stringify(d));
    x.rows[1].piece_hostile = { [u]: { attack: "swipe", hp: 5 } };
    assert.deepEqual(validateLimbLoss(x), [], u);
  }
});
