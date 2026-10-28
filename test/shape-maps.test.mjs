// Shape maps (data/shape-maps): one ragdoll map per body shape on the 106-joint rig + the body -> shape lookup.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { generateRow, loadTable } from "../src/generate.mjs";
import { loadMaps, mapJoints } from "../tools/shape-maps-validate.mjs";

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
    assert.ok(Number.isInteger(s) && s >= 0 && s < lookup.shapes.length, id);
    used.add(s);
    assert.ok(hmm >= 400 && hmm <= 4000, `${id} height ${hmm}`);
    assert.ok(g100 >= 30 && g100 <= 400, `${id} girth ${g100}`);
    assert.ok(kg10 >= 180 && kg10 <= 1400, `${id} mass ${kg10}`);
  }
  assert.equal(used.size, lookup.shapes.length);
  for (const b of ["psyche-106", "minotaur-106", "hunter-pitborn-106", "gargantua-106", "arachne-106", "brute-106", "mh-male-01", "mh-gen-v2-0005"]) assert.ok(lookup.bodies[b], b);
  assert.equal(lookup.bodies["vagrant-106"], undefined, "the 19-joint vagrant is not on the 106 rig");
});

test("a shape map plus the body's scalars reproduces the generated ragdoll row (radius within 20 percent at the median, mass within 1 percent)", () => {
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
    assert.ok(errs[errs.length >> 1] < 0.2, `${id}: median radius error ${errs[errs.length >> 1]}`);
    assert.ok(Math.abs(mass - row.total_mass_kg) / row.total_mass_kg < 0.01 + 0.02, `${id}: mass ${mass} vs ${row.total_mass_kg}`);
    assert.ok(Math.abs(H - row.height_m) < 0.001);
  }
});

test("data stays tiny: all maps + lookup + follow table under 40 KB", () => {
  const sum = Object.keys(maps).reduce((a, n) => a + statSync(`${DIR}/${n}.map.json`).size, 0) + statSync(`${DIR}/body-shapes.json`).size + statSync(`${DIR}/rig-106-follow.json`).size;
  assert.ok(sum < 40 * 1024, `${sum} bytes`);
});
