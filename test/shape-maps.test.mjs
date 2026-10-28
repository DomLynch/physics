// Shape maps (data/shape-maps): one ragdoll map per body shape on the 106-joint rig + the body -> shape lookup.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { generateRow, loadTable } from "../src/generate.mjs";
import { loadMaps, mapJoints } from "../tools/shape-maps-validate.mjs";
import { bodyShape } from "../src/shape-maps.mjs";

const DIR = new URL("../data/shape-maps", import.meta.url).pathname;
const { maps, lookup, follow } = loadMaps(DIR);
const table = loadTable();

test("rig-106-follow lists exactly 106 unique joints: 20 role joints + 86 followers", () => {
  const roles = follow.roleJoints.map((n) => "mixamorig:" + n);
  const all = new Set([...roles, ...Object.keys(follow.follow)]);
  assert.equal(follow.roleJoints.length, 20);
  assert.equal(follow.count, 106);
  assert.equal(all.size, 106);
  for (const [j, to] of Object.entries(follow.follow)) assert.ok(to === null || roles.includes(to), `${j} follows ${to}`);
  assert.equal(follow.follow["mixamorig:LeftHandIndex2"], "mixamorig:LeftHand");
  assert.equal(follow.follow["mixamorig:RightShoulder"], "mixamorig:Spine2");
});

test("one map per shape; every map joint resolves on the 106 rig; parents resolve; each map is under 3 KB", () => {
  assert.deepEqual(Object.keys(maps).sort(), [...lookup.shapes].sort());
  const names = new Set([...follow.roleJoints.map((n) => "mixamorig:" + n), ...Object.keys(follow.follow)]);
  for (const m of Object.values(maps)) {
    assert.equal(m.schema, "shape-map/1");
    assert.equal(m.rig, "mixamo-106");
    assert.equal(m.table, table.schema);
    for (const j of mapJoints(m)) assert.ok(names.has(j), `${m.shape}: ${j} is not a 106-rig joint`);
    const keys = Object.keys(m.roles);
    assert.equal(keys.length, 13);
    for (const [k, r] of Object.entries(m.roles)) {
      assert.ok(r.parent === null || keys.includes(r.parent), `${m.shape}.${k} parent ${r.parent}`);
      assert.ok((r.end === null) === (r.ext !== undefined), `${m.shape}.${k}: end null needs ext`);
      assert.ok(r.r > 0 && r.l > 0 && r.m > 0, `${m.shape}.${k} has a non-positive number`);
    }
    const mass = Object.entries(m.roles).reduce((a, [k, r]) => a + r.m * (k.includes("{S}") ? 2 : 1), 0);
    assert.ok(Math.abs(mass - 1) < 0.02, `${m.shape}: mass fractions sum to ${mass}`);
    assert.ok(statSync(`${DIR}/${m.shape}.map.json`).size < 3072);
  }
});

test("limits are the role table's (degrees), no armour or block fields leak in", () => {
  const byId = Object.fromEntries(table.roles.map((r) => [r.id, r.joint]));
  const idOf = { Hips: "hips", Spine: "spine", Spine1: "spine1", Spine2: "spine2", Neck: "neck", Head: "head", "{S}Arm": "arm", "{S}ForeArm": "forearm", "{S}Hand": "hand", "{S}UpLeg": "thigh", "{S}Leg": "shin", "{S}Foot": "foot", "{S}ToeBase": "toe" };
  for (const m of Object.values(maps)) for (const [k, r] of Object.entries(m.roles)) {
    const t = byId[idOf[k]];
    if (!t) { assert.equal(r.j, null); continue; }
    assert.deepEqual(r.j, t.type === "hinge" ? ["hinge", t.hinge_min_deg, t.hinge_max_deg] : [t.type, t.swing_deg, t.twist_deg], `${m.shape}.${k}`);
  }
  assert.doesNotMatch(JSON.stringify(maps), /block|immune|armour/i);
});

test("lookup: every body names a real shape with sane height, girth and mass; every shape is used; the V3 106 bosses are in", () => {
  const used = new Set();
  for (const [id, [s, hmm, g100, kg10]] of Object.entries(lookup.bodies)) {
    assert.ok(!(id in lookup.excluded), `${id} is both in the lookup and excluded`);
    assert.ok(Number.isInteger(s) && s >= 0 && s < lookup.shapes.length, id);
    used.add(s);
    assert.ok(hmm >= 1000 && hmm <= 3000, `${id} height ${hmm} mm is a scale error, not a body`);
    assert.equal(lookup.bodies[id].length, 5, `${id}: [shape, height, girth, mass, unclamped mass]`);
    if (kg10 === 1400) assert.ok(lookup.bodies[id][4] >= 1400, `${id}: unclamped mass below the 140 kg clamp`);
    assert.ok(g100 >= 30 && g100 <= 400, `${id} girth ${g100}`);
    assert.ok(kg10 >= 180 && kg10 <= 1400, `${id} mass ${kg10}`);
  }
  assert.equal(used.size, lookup.shapes.length);
  for (const b of ["psyche-106", "minotaur-106", "hunter-pitborn-106", "gargantua-106", "arachne-106", "brute-106", "mh-male-01", "mh-gen-v2-0005"]) assert.ok(lookup.bodies[b], b);
  assert.equal(lookup.bodies["vagrant-106"], undefined, "the 19-joint vagrant is not on the 106 rig");
});

test("a shape map plus the body's scalars reproduces the generated ragdoll row (radius within 25 percent at the median, mass within 3 percent)", () => {
  for (const id of ["psyche-106", "minotaur-106", "hunter-pitborn-106", "brute-106", "gargantua-106"]) {
    const m = JSON.parse(readFileSync(new URL(`../data/bodies/${id}.measure.json`, import.meta.url), "utf8"));
    const row = generateRow(id, m, table);
    const [s, hmm, g100, kg10] = lookup.bodies[id];
    const map = maps[lookup.shapes[s]];
    const H = hmm / 1000, g = g100 / 100, kg = kg10 / 10;
    const errs = [];
    let mass = 0;
    for (const [k, r] of Object.entries(map.roles)) for (const S of k.includes("{S}") ? ["Left", "Right"] : [""]) {
      const base = k.replace("{S}", "");
      const gen = row.roles.find((x) => x.id === ({ Hips: "hips", Spine: "spine", Spine1: "spine1", Spine2: "spine2", Neck: "neck", Head: "head", Arm: "arm", ForeArm: "forearm", Hand: "hand", UpLeg: "thigh", Leg: "shin", Foot: "foot", ToeBase: "toe" }[base] + S));
      errs.push(Math.abs(r.r * H * g - gen.radius_m) / gen.radius_m);
      mass += r.m * kg;
    }
    errs.sort((a, b) => a - b);
    // a shape is an approximation: psyche/minotaur/pitborn/brute land at 5 to 11 percent, gargantua (a 2.2 m boss with its own proportions) at about 20
    assert.ok(errs[errs.length >> 1] < 0.25, `${id}: median radius error ${errs[errs.length >> 1]}`);
    assert.ok(Math.abs(mass - row.total_mass_kg) / row.total_mass_kg < 0.01 + 0.02, `${id}: mass ${mass} vs ${row.total_mass_kg}`);
    assert.ok(Math.abs(H - row.height_m) < 0.001);
  }
});

test("scale outliers are excluded with a reason, not given a wrong shape", () => {
  for (const id of ["remy", "the-boss", "pirate-by-p-konstantinov"]) {
    assert.equal(lookup.bodies[id], undefined, id);
    assert.match(lookup.excluded[id], /scale/i, id);
  }
});

test("bodyShape throws a clear error for an unknown or an excluded body, and returns scalars for a known one", () => {
  assert.throws(() => bodyShape(lookup, "no-such-body"), /unknown body "no-such-body"/);
  assert.throws(() => bodyShape(lookup, "remy"), /excluded body "remy".*scale/i);
  const b = bodyShape(lookup, "mon-0056");
  assert.equal(b.shape, "child");
  assert.equal(b.height_m, 1.445);
  assert.equal(typeof b.unclamped_mass_kg, "number");
});

test("one named body per shape gets that shape", () => {
  const expect = { "eve-by-j-gonzales": "child", "ch11-nonpbr": "average-medium", "mon-0830": "average-heavy", "mon-0178": "tall-medium", "mon-0611": "giant-slim", "mon-0630": "giant-heavy", "mon-0297": "giant-massive", "mh-male-01": "average-medium", "psyche-106": "average-medium", "brute-106": "tall-medium", "gargantua-106": "average-heavy" };
  for (const [id, shape] of Object.entries(expect)) assert.equal(bodyShape(lookup, id).shape, shape, id);
  assert.deepEqual(new Set(Object.values(expect)), new Set(lookup.shapes));
});

test("child rule: under 1450 mm is child, so a small adult becomes a child (1445 mm child, 1462 mm average-heavy)", () => {
  assert.equal(lookup.rules.child_max_height_mm, 1450);
  assert.match(lookup.rules.child, /small adult/i);
  assert.equal(bodyShape(lookup, "mon-0056").shape, "child");
  assert.equal(bodyShape(lookup, "mon-0846").shape, "average-heavy");
  assert.equal(bodyShape(lookup, "mon-0846").height_m, 1.462);
  for (const [id, row] of Object.entries(lookup.bodies)) assert.equal(lookup.shapes[row[0]] === "child", row[1] < 1450, `${id} ${row[1]} mm`);
});

test("the 140 kg clamp is stored: unclamped mass sits beside the clamped one, and the data says so", () => {
  assert.match(lookup.rules.mass, /clamp/i);
  const clamped = Object.entries(lookup.bodies).filter(([, r]) => r[3] === 1400);
  assert.ok(clamped.length > 150);
  assert.ok(clamped.some(([, r]) => r[4] > 1400), "some clamped body has a higher true mass");
  assert.ok(bodyShape(lookup, "mon-0297").unclamped_mass_kg > 140);
});

test("data stays tiny: all maps + lookup + follow table under 48 KB", () => {
  const sum = Object.keys(maps).reduce((a, n) => a + statSync(`${DIR}/${n}.map.json`).size, 0) + statSync(`${DIR}/body-shapes.json`).size + statSync(`${DIR}/rig-106-follow.json`).size;
  assert.ok(sum < 48 * 1024, `${sum} bytes`);
});
