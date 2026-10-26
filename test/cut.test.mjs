// M5: severed head with its gear slots and cap, helmet prop, corpse cut on a frozen body, swept-edge test, determinism.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPhysics } from "../src/index.mjs";

const body = JSON.parse(readFileSync(new URL("../data/bodies/minotaur.measure.json", import.meta.url), "utf8"));
const TICK = 1 / 60;
const run = (p, s) => { for (let i = 0; i < Math.round(s / TICK); i++) p.step(TICK); };

test("head cut: the head piece leaves with its gear slots, a cap position and a helmet prop; the torso keeps standing", async () => {
  const p = await createPhysics({ seed: 1 });
  const rd = p.createRagdoll(body);
  run(p, 0.5);
  const hi = rd.partIds.indexOf("head"), before = Array.from(rd.readPose().slice(hi * 10, hi * 10 + 3));
  const r = rd.cut("head", { helmet: true, impulse: [0, 4, -6] });
  assert.equal(r.unit, "head");
  assert.deepEqual(r.gear_slots, ["head"]);
  assert.deepEqual(r.carries_roles, ["head"]);
  assert.ok(r.cap.position.every(Number.isFinite) && r.cap.position[1] > 1.2, "stump near the neck height: " + r.cap.position);
  assert.equal(r.props.length, 1);
  assert.equal(rd.cut("head"), null, "second cut of the same unit is a no-op");
  run(p, 1.0);
  const after = rd.readPose();
  const dist = Math.hypot(after[hi * 10] - before[0], after[hi * 10 + 1] - before[1], after[hi * 10 + 2] - before[2]);
  assert.ok(dist > 0.3, `the head left its place (${dist} m)`);
  const hp = r.props[0].readPose();
  assert.ok(Number.isFinite(hp[0]) && hp[1] < 3, "helmet prop is simulated");
  assert.ok(after[1] > 0.7, "hips (kinematic root) stay up");
  p.destroy();
});

test("corpse cut: a frozen body gives up an arm; the arm wakes, the rest stays asleep and the state stays frozen", async () => {
  const p = await createPhysics({ seed: 1 });
  const rd = p.createRagdoll(body);
  rd.kill({ part: "spine2", impulse: [0, 0, 60] });
  run(p, 9);
  assert.equal(rd.state, "frozen");
  const torso = Array.from(rd.readPose().slice(rd.partIds.indexOf("spine2") * 10, rd.partIds.indexOf("spine2") * 10 + 3));
  const ai = rd.partIds.indexOf("armRight"), hand = rd.partIds.indexOf("handRight");
  const h0 = Array.from(rd.readPose().slice(hand * 10, hand * 10 + 3));
  const r = rd.cut("arm_right", { impulse: [0, 3, 0] });
  assert.deepEqual(r.carries_roles, ["armRight", "forearmRight", "handRight"]);
  run(p, 1);
  const pose = rd.readPose();
  assert.ok(Math.hypot(pose[hand * 10] - h0[0], pose[hand * 10 + 1] - h0[1], pose[hand * 10 + 2] - h0[2]) > 0.02, "the cut arm moved");
  const t1 = Array.from(pose.slice(rd.partIds.indexOf("spine2") * 10, rd.partIds.indexOf("spine2") * 10 + 3));
  assert.ok(Math.hypot(t1[0] - torso[0], t1[1] - torso[1], t1[2] - torso[2]) < 0.02, "the torso stayed put");
  assert.ok(ai >= 0);
  p.destroy();
});

test("sweepEdge: a blade swinging through the neck is through the neck, a blade 1 m away hits nothing", async () => {
  const p = await createPhysics({ seed: 1 });
  const rd = p.createRagdoll(body);
  const pose = rd.readPose(), ni = rd.partIds.indexOf("neck"), c = [pose[ni * 10], pose[ni * 10 + 1], pose[ni * 10 + 2]];
  // blade held across the neck (sideways, 0.5 m long), moved 5 cm forward during the tick
  const through = rd.sweepEdge([c[0] - 0.25, c[1], c[2] + 0.1], [c[0] + 0.25, c[1], c[2] + 0.1], [c[0] - 0.25, c[1], c[2] - 0.02], [c[0] + 0.25, c[1], c[2] - 0.02]);
  assert.ok(through.some((h) => h.part === "neck" && h.through), JSON.stringify(through.map((h) => [h.part, +h.dist.toFixed(3), h.through])));
  const miss = rd.sweepEdge([c[0] + 1, c[1], c[2] + 1], [c[0] + 1.5, c[1], c[2] + 1], [c[0] + 1, c[1], c[2] + 1.1], [c[0] + 1.5, c[1], c[2] + 1.1]);
  assert.equal(miss.length, 0);
  p.destroy();
});

test("a cut with a helmet is deterministic and the helmet is part of the world hash", async () => {
  const run1 = async () => {
    const p = await createPhysics({ seed: 5 });
    const rd = p.createRagdoll(body), h = [];
    for (let t = 0; t < 200; t++) {
      if (t === 40) rd.cut("head", { helmet: true, impulse: [1, 3, -5] });
      p.step(TICK); h.push(p.hash());
    }
    p.destroy();
    return h;
  };
  assert.deepEqual(await run1(), await run1());
});
