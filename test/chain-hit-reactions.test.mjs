// ALIVE hit-reaction rows for the chain bodies (data/hit-reactions.chain.json, src/chain-reactions.mjs) and the chain-role stagger targets (data/states.json).
// The rows are data keyed by chain PART id; the game's bone-maths layer reads them through boneMap. Physics only has to stay sane under the same blow:
// stagger + impulse on a living chain ragdoll is deterministic, finite for 180 ticks, motors come back to base, the body is alive, and a cut / kill afterwards still works.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as pkg from "../src/index.mjs";
import { createPhysics, loadChainBody, chainBodyNames } from "../src/index.mjs";

const json = (f) => JSON.parse(readFileSync(new URL(f, import.meta.url), "utf8"));
let DATA = { families: {}, no_joints: [] };
try { DATA = json("../data/hit-reactions.chain.json"); } catch { /* red until the data file lands: each test then fails on its own */ }
const STATES = json("../data/states.json");
const TICK = 1 / 60;
const ZONES = ["head", "front_body", "rear_body", "legs", "tail"], DIRS = ["front", "back", "left", "right"];
const JOINTED = chainBodyNames().filter((n) => n !== "drone");
// the loaders are looked up by name so a missing export fails each test, not the whole file
const load = (name) => pkg.loadChainReactions(name);
const validate = (d) => pkg.validateChainReactions(d);

test("the ten chain bodies are listed, drone has no joints", () => {
  assert.equal(JOINTED.length, 9);
  assert.deepEqual(DATA.no_joints, ["drone"]);
});

test("the shipped rows validate (closed schema) and cover every jointed chain body exactly once", () => {
  assert.deepEqual(validate(DATA), []);
  const seen = [];
  for (const f of Object.values(DATA.families)) seen.push(...f.bodies);
  assert.deepEqual([...seen].sort(), [...JOINTED].sort(), "every jointed body in exactly one family");
});

test("loadChainReactions: rows for each body, every part id exists in that body's chain spec, drone returns none, unknown body throws", () => {
  for (const name of JOINTED) {
    const R = load(name), spec = loadChainBody(name).spec, ids = new Set(spec.segments.map((s) => s.id));
    assert.equal(R.body, name);
    assert.ok(R.rows.length >= 16, `${name}: ${R.rows.length} rows`);
    const zones = new Set(R.rows.map((r) => r.zone));
    for (const z of ["head", "front_body", "rear_body"]) assert.ok(zones.has(z), `${name}: zone ${z}`);
    for (const z of zones) for (const d of DIRS) assert.equal(R.rows.filter((r) => r.zone === z && r.dir === d).length, 1, `${name}: ${z}/${d} exactly one row`);
    for (const r of R.rows) {
      assert.ok(ZONES.includes(r.zone) && DIRS.includes(r.dir));
      assert.ok(ids.has(r.part), `${name}: struck part ${r.part}`);
      assert.ok(Object.keys(r.weights).length > 0);
      for (const [id, [bend, twist]] of Object.entries(r.weights)) {
        assert.ok(ids.has(id), `${name}: weight part ${id}`);
        assert.ok(bend >= 0 && bend <= 1 && twist >= -1 && twist <= 1, `${name}: ${id} weights`);
      }
      assert.ok(r.impulse_scale > 0 && r.hold_s > 0 && r.hold_s <= 2);
      assert.ok(Math.abs(Math.hypot(...r.impulse_dir) - 1) < 1e-9, "impulse_dir is a unit vector");
    }
  }
  assert.deepEqual(load("drone").rows, []);
  assert.throws(() => load("no-such-creature"), /no-such-creature/);
});

test("the legs rows pick a real leg, eel has no legs or tail-less zones it cannot fill, tails exist only on bodies with a tail part", () => {
  assert.ok(!load("eel").rows.some((r) => r.zone === "legs"));
  for (const name of JOINTED) {
    const R = load(name), spec = loadChainBody(name).spec;
    const hasTail = spec.segments.some((s) => (s.role || s.id) === "tail"), hasLeg = spec.segments.some((s) => (s.role || s.id).startsWith("leg"));
    assert.equal(R.rows.some((r) => r.zone === "tail"), hasTail, `${name}: tail rows iff a tail part`);
    assert.equal(R.rows.some((r) => r.zone === "legs"), hasLeg, `${name}: legs rows iff legs`);
  }
});

test("the validator refuses an unknown key, a part id the body does not have, a weight out of range, a missing direction and a body in two families", () => {
  const clone = () => JSON.parse(JSON.stringify(DATA));
  const bad = (mutate) => { const d = clone(); mutate(d); return validate(d).length > 0; };
  assert.ok(bad((d) => { d.surprise = 1; }), "unknown top-level key");
  assert.ok(bad((d) => { d.families.quadruped.rows[0].surprise = 1; }), "unknown row key");
  assert.ok(bad((d) => { d.families.quadruped.rows[0].part = "no_such_part"; }), "struck part not in the body");
  assert.ok(bad((d) => { d.families.quadruped.rows[0].weights.no_such_part = [0.1, 0]; }), "weight part not in the body");
  assert.ok(bad((d) => { d.families.quadruped.rows[0].weights.hips = [1.5, 0]; }), "bend over 1");
  assert.ok(bad((d) => { d.families.quadruped.rows[0].weights.hips = [0.5, -1.5]; }), "twist under -1");
  assert.ok(bad((d) => { d.families.quadruped.rows[0].weights.hips = [0.5]; }), "weights must be [bend, twist]");
  assert.ok(bad((d) => { d.families.quadruped.rows[0].hold_s = 0; }), "zero hold");
  assert.ok(bad((d) => { d.families.quadruped.rows[0].zone = "belly"; }), "unknown zone");
  assert.ok(bad((d) => { d.families.quadruped.rows.pop(); }), "a direction missing from a zone");
  assert.ok(bad((d) => { d.families.eel.bodies.push("wolf"); }), "a body in two families");
  assert.ok(bad((d) => { d.families.eel.bodies = ["no-such-creature"]; }), "unknown body");
  assert.ok(bad((d) => { d.impulse_dirs.front = [0, 0, -2]; }), "impulse dir not a unit vector");
  assert.ok(bad((d) => { d.schema = "chain-hit-reactions/2"; }), "wrong schema");
});

test("stagger targets name every chain role; the humanoid targets are byte-identical", () => {
  const HUMANOID = { arm: 0.9, forearm: 0.6, hand: 0.12, spine: 0.6, spine1: 0.6, spine2: 0.6, neck: 0.6, head: 0.6, thigh: 0.6, shin: 0.6, foot: 0.6, toe: 0.6 };
  const T = STATES.stagger.targets;
  for (const [k, v] of Object.entries(HUMANOID)) assert.equal(T[k], v, `humanoid target ${k} unchanged`);
  for (const name of chainBodyNames()) {
    for (const s of loadChainBody(name).spec.segments.slice(1)) {
      const role = s.role || s.id;
      assert.ok(typeof T[role] === "number" && T[role] > 0 && T[role] < 1, `${name}: stagger target for role ${role}`);
    }
  }
  assert.equal(STATES.stagger.hold_s, 0.5);
  assert.equal(STATES.stagger.up_s, 0.35);
  assert.equal(STATES.stagger.ease_in_s, 0.05);
});

// ---- physics under every row
const blow = (row, rd) => {
  const m = rd.row.roles.find((r) => r.id === row.part).mass_kg, k = row.impulse_scale * m;
  return { part: row.part, impulse: row.impulse_dir.map((c) => c * k) };
};
async function run(name, row, { after = "kill" } = {}) {
  const p = await createPhysics({ seed: 7 });
  const rd = p.createRagdoll(loadChainBody(name).row, { id: name });
  const hashes = [], base = rd.row.roles.length;
  for (let t = 0; t < 30; t++) p.step(TICK);
  rd.stagger(blow(row, rd));
  assert.equal(rd.state, "stagger");
  for (let t = 0; t < 180; t++) {
    p.step(TICK);
    hashes.push(p.hash());
    for (const v of rd.readPose()) assert.ok(Number.isFinite(v), `${name} ${row.zone}/${row.dir}: NaN at tick ${t}`);
  }
  assert.equal(rd.state, "alive", `${name} ${row.zone}/${row.dir}: stagger ended, the body is alive`);
  assert.equal(rd.cuts.length, 0);
  const out = { hashes, n: base };
  // a cut and then a kill afterwards still work
  const unit = rd.row.severable.find((s) => !s.visual_only);
  if (unit) { const cut = rd.cut(unit.id, { impulse: [0, 1, 0] }); assert.ok(cut && cut.unit === unit.id, `${name}: cut ${unit.id} after the reaction`); assert.deepEqual(rd.cuts, [unit.id]); }
  rd.kill({ part: row.part, impulse: blow(row, rd).impulse });
  assert.equal(rd.state, "dying");
  for (let t = 0; t < 120; t++) { p.step(TICK); hashes.push(p.hash()); for (const v of rd.readPose()) assert.ok(Number.isFinite(v), `${name}: NaN after kill at ${t}`); }
  p.destroy();
  return out;
}

for (const name of JOINTED) {
  test(`${name}: stagger + impulse on every zone/direction row is deterministic, finite for 180 ticks, alive after, and a cut then a kill still work`, async () => {
    const R = load(name);
    for (const row of R.rows) {
      const a = await run(name, row), b = await run(name, row);
      assert.deepEqual(a.hashes, b.hashes, `${name} ${row.zone}/${row.dir}: replay differs`);
    }
  });
}

test("motor strength returns to base: a staggered body settles to where an untouched one with the same base strength sits (wolf, base 1 and base 0.8)", async () => {
  for (const base of [1, 0.8]) {
    const p = await createPhysics({ seed: 7 });
    const { row } = loadChainBody("wolf");
    const hit = p.createRagdoll(row, { id: "hit", position: [0, 0, 0] }), calm = p.createRagdoll(row, { id: "calm", position: [30, 0, 0] });
    hit.setMotorStrength({ all: base }); calm.setMotorStrength({ all: base });
    for (let t = 0; t < 30; t++) p.step(TICK);
    hit.stagger(); // no impulse: only the motor dip
    assert.equal(hit.state, "stagger");
    for (let t = 0; t < 240; t++) p.step(TICK);
    assert.equal(hit.state, "alive");
    const a = hit.readPose(), b = calm.readPose();
    let worst = 0;
    for (let i = 0; i < row.roles.length; i++) for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs((a[i * 10 + k] - a[k]) - (b[i * 10 + k] - b[k])));
    assert.ok(worst < 2e-3, `base ${base}: parts differ from the untouched body by ${worst} m`);
    p.destroy();
  }
});

test("the chain-role targets matter: with the humanoid-only targets the tail and legs do not dip, with the shipped targets they do", async () => {
  const sag = async (states) => {
    const p = await createPhysics({ seed: 7, states });
    const { row } = loadChainBody("wolf");
    const rd = p.createRagdoll(row, { id: "w" });
    for (let t = 0; t < 30; t++) p.step(TICK);
    rd.stagger();
    for (let t = 0; t < 21; t++) p.step(TICK); // inside the hold
    const ids = rd.partIds, pose = Float32Array.from(rd.readPose());
    p.destroy();
    return Object.fromEntries(ids.map((id, i) => [id, [pose[i * 10], pose[i * 10 + 1], pose[i * 10 + 2]]]));
  };
  const humanoidOnly = { stagger: { targets: { arm: 0.9, forearm: 0.6, hand: 0.12, spine: 0.6, spine1: 0.6, spine2: 0.6, neck: 0.6, head: 0.6, thigh: 0.6, shin: 0.6, foot: 0.6, toe: 0.6 } } };
  const a = await sag(humanoidOnly), b = await sag({});
  const d = (id) => Math.hypot(...a[id].map((v, k) => v - b[id][k]));
  assert.ok(d("tail_b") > 1e-4 || d("tail_a") > 1e-4, `tail moved by ${d("tail_b")} / ${d("tail_a")} m`);
  assert.ok(["hind_low_L", "front_low_L", "hind_up_L"].some((id) => d(id) > 1e-4), "a leg moved");
});
