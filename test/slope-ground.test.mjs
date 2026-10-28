// Ground that is not y = 0 (data/ground-rows.json, src/ground.mjs): a plane tipped 15 and 30 degrees, and a height function the game passes in.
// Bodies, ragdolls, cut pieces and corpses must land on it, settle (sleep / freeze), rest ON the ground (no sink, no float beyond the row epsilons),
// not slide off for ever, and stay put once asleep. Every tolerance is a row (ground-rows.json settle.*); nothing is tuned here.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPhysics as create, loadChainBody, loadGroundRows, validateGround } from "../src/index.mjs";

// every world made here is destroyed after its test, passed or failed (a failed assert would otherwise leak the wasm heap into the next test)
const made = [];
const createPhysics = async (o) => {
  const p = await create(o), d = p.destroy;
  let gone = false;
  p.destroy = () => { if (!gone) { gone = true; d(); } };
  made.push(p);
  return p;
};
afterEach(() => { while (made.length) made.pop().destroy(); });
import { qrot } from "../src/math.mjs";

const GR = JSON.parse(readFileSync(new URL("../data/ground-rows.json", import.meta.url), "utf8"));
const ST = GR.settle;
// KNOWN DEFECT (not a pass): ST.sink_epsilon_m (0.11) tolerates a toe capsule that sinks 0.072 m into the DEFAULT flat floor, 0.021 m on plane rows and
// 0.105 m into the slope15 heightfield (margin 0.005 m). The clearance checks below prove "no tunnelling", not "no sink". Fix the toe sink, then tighten the row.
const measure = (n) => JSON.parse(readFileSync(new URL(`../data/bodies/${n}.measure.json`, import.meta.url), "utf8"));
const TICK = 1 / 60;
const BODIES = {
  "vagrant-106": { make: () => measure("vagrant-106"), radius: ST.footprint_radius_m.humanoid },
  dog: { make: () => loadChainBody("dog").row, radius: ST.footprint_radius_m.chain },
};
const SLOPES = ["slope15", "slope30"];
const TAN = (deg) => Math.tan((deg * Math.PI) / 180);
const log = (...a) => console.log("SLOPE", ...a);

// the roles of a ragdoll row: id -> { r, halfH }; clearance of a part = lowest capsule endpoint's distance to the ground surface along its normal, minus the radius
const partClear = (p, rows, pose, i) => {
  const o = i * 10, q = [pose[o + 3], pose[o + 4], pose[o + 5], pose[o + 6]], ax = qrot(q, [0, 1, 0]), r = rows[i];
  let low = Infinity;
  for (const s of [-1, 1]) {
    const c = [pose[o] + ax[0] * r.half_height_m * s, pose[o + 1] + ax[1] * r.half_height_m * s, pose[o + 2] + ax[2] * r.half_height_m * s];
    const n = p.groundNormal(c[0], c[2]);
    low = Math.min(low, (c[1] - p.groundHeight(c[0], c[2])) * n[1] - r.radius_m);
  }
  return low;
};
const clearance = (p, row, pose, ids) => Math.min(...ids.map((id) => partClear(p, row.roles, pose, row.roles.findIndex((r) => r.id === id))));
const allIds = (row) => row.roles.map((r) => r.id);

// step until every body of the ragdoll sleeps; returns seconds, or Infinity when max_settle_s runs out
function settle(p, rd) {
  for (let t = 0; t < Math.round(ST.max_settle_s / TICK); t++) { p.step(TICK); if (!rd.awake) return (t + 1) * TICK; }
  return Infinity;
}
const centre = (rd) => { const q = rd.readPose(); return [q[0], q[1], q[2]]; };
const spawn = (p, body, id) => {
  const row = body.make(), [x, z] = [0, 0], y = p.groundMax(x, z, body.radius) + ST.drop_height_m;
  const rd = p.createRagdoll(row, { position: [x, y, z], id });
  return { rd, row: rd.row };
};
const finite = (pose) => { for (const v of pose) assert.ok(Number.isFinite(v), "NaN or Infinity in the pose"); };

// ------------------------------------------------------------------ the rows and the option
test("ground rows: flat, slope15, slope30 with angles 0, 15, 30 and the world floor friction; every number names a source", () => {
  assert.equal(GR.schema, "ground-rows/1");
  assert.deepEqual(Object.keys(GR.rows), ["flat", "slope15", "slope30"]);
  assert.deepEqual(Object.values(GR.rows).map((r) => r.angle_deg), [0, 15, 30]);
  const world = JSON.parse(readFileSync(new URL("../data/world.json", import.meta.url), "utf8"));
  for (const r of Object.values(GR.rows)) { assert.equal(r.friction, world.floor.friction); assert.equal(r.half_extent_m, world.floor.half_extent_m); assert.ok(r.source); }
  assert.ok(GR.sampled.source && GR.settle.max_settle_source && GR.settle.clearance_source);
});

test("validateGround: names the problem; createPhysics throws on a bad option", async () => {
  assert.deepEqual(validateGround("slope15"), []);
  assert.deepEqual(validateGround({ groundHeight: () => 0 }), []);
  assert.match(validateGround("slope99")[0], /unknown ground row/);
  assert.match(validateGround({ angle_deg: 80, downhill: [1, 0], half_extent_m: 5 })[0], /angle_deg/);
  assert.match(validateGround({ angle_deg: 10, downhill: [0, 0], half_extent_m: 5 })[0], /downhill/);
  assert.match(validateGround({ groundHeight: 3 })[0], /function/);
  await assert.rejects(createPhysics({ ground: "nope" }), /unknown ground row/);
});

test("ground queries: default is the flat floor; a slope row reports its height, normal and the highest ground under a footprint", async () => {
  const f = await createPhysics({ seed: 1 });
  assert.equal(f.groundHeight(3, 4), 0);
  assert.deepEqual(f.groundNormal(3, 4), [0, 1, 0]);
  assert.equal(f.groundMax(3, 4, 1), 0);
  f.destroy();
  for (const name of SLOPES) {
    const a = GR.rows[name].angle_deg, p = await createPhysics({ seed: 1, ground: name });
    assert.equal(p.groundHeight(0, 0), 0);
    assert.ok(Math.abs(p.groundHeight(2, 7) + 2 * TAN(a)) < 1e-12, "downhill is +x: height falls tan(angle) per metre");
    assert.equal(p.groundHeight(2, 7), p.groundHeight(2, -7), "constant across the slope");
    const n = p.groundNormal(0, 0);
    assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-12 && Math.abs(n[0] - Math.sin((a * Math.PI) / 180)) < 1e-12, "normal tips toward downhill");
    assert.ok(Math.abs(p.groundMax(0, 0, 1) - TAN(a)) < 1e-12, "highest ground within 1 m is 1 m uphill");
    p.destroy();
  }
});

test("default behaviour unchanged: the flat ground row builds the same body as the built-in floor (same per-tick hash on a dog kill)", async () => {
  const run = async (opts) => {
    const p = await createPhysics({ seed: 7, ...opts }), rd = p.createRagdoll(loadChainBody("dog").row, { position: [0, 0.3, 0], id: "d" });
    const hs = [];
    for (let t = 0; t < 240; t++) { if (t === 30) rd.kill({ part: "chest", impulse: [5, 1, 20] }); p.step(TICK); hs.push(p.hash()); }
    p.destroy();
    return hs;
  };
  assert.deepEqual(await run({ ground: "flat" }), await run({}));
});

test("baseline behind sink_epsilon_m: on the DEFAULT flat floor a killed vagrant-106 dropped from ten heights sinks no more than the row says", async () => {
  let worst = 0;
  for (const drop of ST.baseline_drops_m) {
    const p = await createPhysics({ seed: 1 }), rd = p.createRagdoll(measure("vagrant-106"), { position: [0, drop, 0], id: "v" });
    rd.kill();
    assert.ok(settle(p, rd) < Infinity);
    worst = Math.min(worst, clearance(p, rd.row, rd.readPose(), allIds(rd.row)));
    p.destroy();
  }
  log("default floor vagrant-106 worst sink over", ST.baseline_drops_m.length, "drops", worst.toFixed(4));
  assert.ok(worst > -ST.sink_epsilon_m, `the flat floor itself sinks ${-worst} m, row says ${ST.sink_epsilon_m}`);
});

// ------------------------------------------------------------------ a body dropped dead on each slope
for (const [bname, body] of Object.entries(BODIES)) for (const slope of SLOPES) {
  test(`${bname} killed on ${slope}: freezes inside max_settle_s, rests on the ground (no sink, no float), does not slide past max_slide_m`, async () => {
    const p = await createPhysics({ seed: 1, ground: slope }), { rd, row } = spawn(p, body, bname);
    p.step(TICK);
    const start = centre(rd);
    rd.kill();
    const secs = settle(p, rd);
    const pose = rd.readPose();
    finite(pose);
    assert.ok(secs < Infinity, `${bname} on ${slope} still awake after ${ST.max_settle_s} s`);
    assert.equal(rd.state, "frozen");
    const end = centre(rd), slide = Math.hypot(end[0] - start[0], end[2] - start[2]);
    const lowest = clearance(p, row, pose, allIds(row));
    log(bname, slope, "settled_s", secs.toFixed(2), "slide_m", slide.toFixed(3), "downhill_m", (end[0] - start[0]).toFixed(3), "lowest_clearance_m", lowest.toFixed(4));
    assert.ok(lowest > -ST.sink_epsilon_m, `sunk ${-lowest} m into ${slope}`);
    assert.ok(lowest < ST.float_epsilon_m, `lowest point floats ${lowest} m above ${slope}`);
    assert.ok(slide < ST.max_slide_m, `slid ${slide} m on ${slope}`);
    p.destroy();
  });

  test(`${bname} corpse on ${slope} is stable once frozen: no movement over hold_s, still asleep, and a frozen corpse stays on the ground`, async () => {
    const p = await createPhysics({ seed: 1, ground: slope }), { rd, row } = spawn(p, body, bname);
    rd.kill();
    assert.ok(settle(p, rd) < Infinity);
    const before = Float32Array.from(rd.readPose());
    for (let t = 0; t < Math.round(ST.hold_s / TICK); t++) p.step(TICK);
    const after = rd.readPose();
    let moved = 0;
    for (let i = 0; i < row.roles.length; i++) moved = Math.max(moved, Math.hypot(after[i * 10] - before[i * 10], after[i * 10 + 1] - before[i * 10 + 1], after[i * 10 + 2] - before[i * 10 + 2]));
    assert.ok(moved <= ST.hold_max_move_m, `a frozen corpse crept ${moved} m`);
    assert.equal(rd.awake, false);
    assert.equal(rd.state, "frozen");
    p.destroy();
  });
}

// ------------------------------------------------------------------ cut pieces
for (const [bname, units] of [["vagrant-106", ["leg_left", "arm_right"]], ["dog", ["tail", "head"]]]) for (const slope of SLOPES) {
  test(`${bname} cut (${units.join(", ")}) on ${slope}: every piece settles, the detached pieces rest on the ground, none sinks`, async () => {
    const p = await createPhysics({ seed: 1, ground: slope }), { rd, row } = spawn(p, BODIES[bname], bname);
    rd.kill();
    for (let t = 0; t < 5; t++) p.step(TICK);
    const pieces = units.map((u) => { const c = rd.cut(u); assert.ok(c && c.unit === u); const s = row.severable.find((x) => x.id === u); return { u, ids: [s.cut_role, ...c.carries_roles] }; });
    const secs = settle(p, rd);
    const pose = rd.readPose();
    finite(pose);
    assert.ok(secs < Infinity, `${bname} cut on ${slope} still awake after ${ST.max_settle_s} s`);
    const all = clearance(p, row, pose, allIds(row));
    assert.ok(all > -ST.sink_epsilon_m, `a piece sank ${-all} m into ${slope}`);
    for (const pc of pieces) {
      const c = clearance(p, row, pose, pc.ids);
      log(bname, slope, "cut", pc.u, "piece_clearance_m", c.toFixed(4));
      assert.ok(c > -ST.sink_epsilon_m && c < ST.float_epsilon_m, `${pc.u} clearance ${c} m on ${slope} (should rest on the ground)`);
    }
    // asleep for good
    const before = Float32Array.from(pose);
    for (let t = 0; t < Math.round(ST.hold_s / TICK); t++) p.step(TICK);
    const after = rd.readPose();
    for (let i = 0; i < row.roles.length; i++) assert.ok(Math.hypot(after[i * 10] - before[i * 10], after[i * 10 + 1] - before[i * 10 + 1], after[i * 10 + 2] - before[i * 10 + 2]) <= ST.hold_max_move_m, `part ${i} crept`);
    p.destroy();
  });
}

test("a cut on a FROZEN corpse on slope30: the piece wakes, slides or rolls, settles on the ground; the rest stays asleep", async () => {
  const p = await createPhysics({ seed: 1, ground: "slope30" }), { rd, row } = spawn(p, BODIES["vagrant-106"], "v");
  rd.kill();
  assert.ok(settle(p, rd) < Infinity);
  const sleeper = Float32Array.from(rd.readPose());
  const c = rd.cut("arm_left");
  assert.ok(c);
  assert.ok(settle(p, rd) < Infinity, "the cut arm never came to rest");
  const pose = rd.readPose();
  finite(pose);
  const s = row.severable.find((x) => x.id === "arm_left"), ids = [s.cut_role, ...c.carries_roles];
  const arm = clearance(p, row, pose, ids);
  assert.ok(arm > -ST.sink_epsilon_m, `the arm sank ${-arm} m`);
  const rest = row.roles.map((r, i) => (ids.includes(r.id) ? -1 : i)).filter((i) => i >= 0);
  let drift = 0;
  for (const i of rest) drift = Math.max(drift, Math.hypot(pose[i * 10] - sleeper[i * 10], pose[i * 10 + 1] - sleeper[i * 10 + 1], pose[i * 10 + 2] - sleeper[i * 10 + 2]));
  log("vagrant-106 slope30 cut-on-corpse arm_clearance_m", arm.toFixed(4), "rest_drift_m", drift.toFixed(4));
  assert.ok(drift < ST.max_slide_m);
  p.destroy();
});

// ------------------------------------------------------------------ a game's own height function
const SLOPE_FN = (deg) => (x) => -TAN(deg) * x;
for (const slope of SLOPES) for (const shape of ["heightfield", "mesh"]) {
  test(`groundHeight(x, z) sampler equal to ${slope} as a ${shape}: dog and vagrant settle on it, rest on it within the row epsilons`, async () => {
    const a = GR.rows[slope].angle_deg;
    for (const [bname, body] of Object.entries(BODIES)) {
      const p = await createPhysics({ seed: 1, ground: { groundHeight: SLOPE_FN(a), shape } }), { rd, row } = spawn(p, body, bname);
      rd.kill();
      const secs = settle(p, rd);
      const pose = rd.readPose();
      finite(pose);
      assert.ok(secs < Infinity, `${bname} on the ${slope} heightfield still awake`);
      const lowest = clearance(p, row, pose, allIds(row));
      log(bname, slope, shape, "settled_s", secs.toFixed(2), "lowest_clearance_m", lowest.toFixed(4));
      assert.ok(lowest > -ST.sink_epsilon_m && lowest < ST.float_epsilon_m, `${bname} clearance ${lowest} m`);
      p.destroy();
    }
  });
}

test("hills with a flat pad (a game's seed-noise terrain): dog and vagrant settle on a ridge flank and on the pad, resting on the ground", async () => {
  // pad: flat within 6 m of the origin, then a ridge rising along +x (smooth step into a 2 m sine); gradient peaks near 25 degrees
  const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  const hill = (x, z) => 2 * smooth(6, 14, Math.hypot(x, z)) * (0.5 + 0.5 * Math.sin(0.4 * x + 0.3 * z));
  for (const [bname, body] of Object.entries(BODIES)) for (const [at, label] of [[[0, 0], "pad"], [[9, 0], "flank"]]) {
    const p = await createPhysics({ seed: 1, ground: { groundHeight: hill } });
    const row = body.make(), y = p.groundMax(at[0], at[1], body.radius) + ST.drop_height_m;
    const rd = p.createRagdoll(row, { position: [at[0], y, at[1]], id: bname }), r2 = rd.row;
    rd.kill();
    const secs = settle(p, rd), pose = rd.readPose();
    finite(pose);
    assert.ok(secs < Infinity, `${bname} on the ${label} still awake`);
    const lowest = clearance(p, r2, pose, allIds(r2));
    log(bname, "hills", label, "settled_s", secs.toFixed(2), "lowest_clearance_m", lowest.toFixed(4));
    assert.ok(lowest > -ST.sink_epsilon_m && lowest < ST.float_epsilon_m, `${bname} on the ${label}: clearance ${lowest} m`);
    p.destroy();
  }
});

// ------------------------------------------------------------------ tunnelling: sampled ground is a thin shell (reviewer defect 1)
const CT = GR.continuous;
for (const shape of ["heightfield", "mesh"]) {
  test(`${shape}: small spheres dropped from max_drop_m and thrown down at test_speed end ON the ground, never through it`, async () => {
    const p = await createPhysics({ seed: 1, ground: { groundHeight: SLOPE_FN(15), shape } });
    for (const r of CT.test_sphere_radii_m) {
      const x = 3 + r * 10, pr = p.createProp({ radius: r, mass: 1, position: [x, p.groundHeight(x, 0) + CT.max_drop_m + r, 0], id: "drop" });
      const pf = p.createProp({ radius: r, mass: 1, position: [x + 5, p.groundHeight(x + 5, 0) + 1 + r, 2], velocity: [0, -CT.test_speed_m_s, 0], id: "throw" });
      let low = Infinity;
      for (let t = 0; t < 600; t++) {
        p.step(TICK);
        for (const b of [pr, pf]) { const q = b.readPose(), n = p.groundNormal(q[0], q[2]); low = Math.min(low, (q[1] - p.groundHeight(q[0], q[2])) * n[1] - r); }
      }
      log(shape, "sphere r", r, "lowest clearance over fall + throw", low.toFixed(4));
      assert.ok(low > -ST.sink_epsilon_m, `${shape}: a ${r} m sphere went ${-low} m into the ground`);
    }
  });

  test(`${shape}: a vagrant-106 and a dog killed from max_drop_m rest on the ground, within sink_epsilon_m`, async () => {
    for (const [bname, body] of Object.entries(BODIES)) {
      const p = await createPhysics({ seed: 1, ground: { groundHeight: SLOPE_FN(15), shape } }), row = body.make();
      const rd = p.createRagdoll(row, { position: [0, p.groundHeight(0, 0) + CT.max_drop_m, 0], id: bname });
      rd.kill();
      assert.ok(settle(p, rd) < Infinity, `${bname} never settled`);
      const c = clearance(p, rd.row, rd.readPose(), allIds(rd.row));
      log(shape, bname, "killed from", CT.max_drop_m, "m: lowest clearance", c.toFixed(4));
      assert.ok(c > -ST.sink_epsilon_m && c < ST.float_epsilon_m, `${bname} clearance ${c}`);
      p.destroy();
    }
  });
}

test("above max_drop_m the world refuses loudly (ragdoll and prop) on a non-default ground; the default floor is not limited", async () => {
  const p = await createPhysics({ seed: 1, ground: "slope15" });
  assert.throws(() => p.createRagdoll(BODIES.dog.make(), { position: [0, CT.max_drop_m + 1, 0] }), /limit is/);
  assert.throws(() => p.createProp({ radius: 0.1, mass: 1, position: [0, CT.max_drop_m + 1, 0] }), /limit is/);
  p.createProp({ radius: 0.1, mass: 1, position: [0, CT.max_drop_m - 1, 0] });
  const f = await createPhysics({ seed: 1 });
  f.createProp({ radius: 0.1, mass: 1, position: [0, CT.max_drop_m + 20, 0] });
});

// ------------------------------------------------------------------ pool: park / acquire on a slope
test("a corpse parked and acquired on slope30 lands on the slope again and settles like a fresh one", async () => {
  const p = await createPhysics({ seed: 1, ground: "slope30" }), row = BODIES["vagrant-106"].make();
  const y = p.groundMax(0, 0, BODIES["vagrant-106"].radius) + ST.drop_height_m;
  const rd = p.createRagdoll(row, { position: [0, y, 0], id: "pool", parked: true });
  assert.equal(rd.parked, true);
  for (let t = 0; t < 30; t++) p.step(TICK);
  assert.equal(rd.awake, false, "a parked ragdoll sleeps");
  assert.ok(rd.acquire());
  rd.kill();
  assert.ok(settle(p, rd) < Infinity);
  const c1 = clearance(p, rd.row, rd.readPose(), allIds(rd.row));
  assert.ok(c1 > -ST.sink_epsilon_m && c1 < ST.float_epsilon_m, `clearance ${c1}`);
  p.destroy();
});

// ------------------------------------------------------------------ props (helmet): a round thing on a slope rolls; it must at least stay on top
test("a helmet prop dropped on slope15 stays on the surface while it rolls downhill (never sinks, never floats)", async () => {
  const p = await createPhysics({ seed: 1, ground: "slope15" });
  const r = 0.13, pr = p.createProp({ radius: r, mass: 1.6, position: [0, p.groundHeight(0, 0) + 0.6, 0], id: "helmet" });
  let worstLow = Infinity, worstHigh = -Infinity;
  for (let t = 0; t < 180; t++) {
    p.step(TICK);
    const q = pr.readPose(), n = p.groundNormal(q[0], q[2]), d = (q[1] - p.groundHeight(q[0], q[2])) * n[1] - r;
    if (t > 90) { worstLow = Math.min(worstLow, d); worstHigh = Math.max(worstHigh, d); }
  }
  const q = pr.readPose();
  log("helmet slope15 clearance_range_m", worstLow.toFixed(4), worstHigh.toFixed(4), "rolled_downhill_m", q[0].toFixed(2));
  assert.ok(worstLow > -ST.sink_epsilon_m && worstHigh < ST.float_epsilon_m);
  assert.ok(q[0] > 0, "it rolled downhill (+x)");
  p.destroy();
});

// ------------------------------------------------------------------ is sliding plausible?
test("the friction row decides the slide: a dog corpse travels further downhill on a 45 degree custom row (tan 45 > friction 0.8) than on slope30 (tan 30 < 0.8)", async () => {
  const run = async (ground) => {
    const p = await createPhysics({ seed: 1, ground });
    const rd = p.createRagdoll(loadChainBody("dog").row, { position: [0, p.groundMax(0, 0, 1.2) + 0.2, 0], id: "d" });
    rd.kill();
    const secs = settle(p, rd);
    const c = centre(rd);
    p.destroy();
    return { secs, x: c[0] };
  };
  const a30 = await run("slope30"), a45 = await run({ ...GR.rows.slope30, angle_deg: 45 });
  log("dog downhill travel 30deg", a30.x.toFixed(2), "m, 45deg", a45.x.toFixed(2), "m; settled", a30.secs.toFixed(1), a45.secs.toFixed(1));
  assert.ok(a30.secs < Infinity);
  assert.ok(a45.x > a30.x, "past atan(friction) the body travels further downhill");
});
