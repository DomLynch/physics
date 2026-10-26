// M3 runners: death ramp (1 -> 0.01 over 1 s, hit impulse same tick, freeze), stagger dip (hold 0.5 s, back over 0.35 s), knockdown (TABG values).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPhysics } from "../src/index.mjs";

const body = JSON.parse(readFileSync(new URL("./fixtures/body-0002.measure.json", import.meta.url), "utf8"));
const TICK = 1 / 60;
const ticks = (p, s) => { for (let i = 0; i < Math.round(s / TICK); i++) p.step(TICK); };

test("death: ramps to 0.01 over 1 s, collapses, freezes, and an impulse wakes it", async () => {
  const p = await createPhysics({ seed: 1 });
  const rd = p.createRagdoll(body);
  ticks(p, 0.5);
  rd.kill({ part: "spine2", impulse: [0, 0, 60] });
  assert.equal(rd.state, "dying");
  ticks(p, 0.5);
  assert.equal(rd.state, "dying");
  ticks(p, 8);
  assert.equal(rd.state, "frozen", "should freeze within 8.5 s");
  const pose = Float32Array.from(rd.readPose());
  ticks(p, 1);
  assert.deepEqual(Array.from(rd.readPose()), Array.from(pose), "frozen pose must not move");
  assert.ok(pose[1] < 0.25, `hips at ${pose[1]} m`);
  rd.applyImpulse("head", [5, 0, 0]);
  p.step(TICK);
  assert.notEqual(rd.state, "frozen");
  p.destroy();
});

test("stagger: dips and returns to alive after 0.05 + 0.5 + 0.35 s, never falls", async () => {
  const p = await createPhysics({ seed: 1 });
  const rd = p.createRagdoll(body);
  ticks(p, 0.5);
  rd.stagger({ part: "spine2", impulse: [0, 0, 30] });
  assert.equal(rd.state, "stagger");
  ticks(p, 0.5);
  assert.equal(rd.state, "stagger");
  ticks(p, 0.5);
  assert.equal(rd.state, "alive");
  const pose = rd.readPose();
  for (const v of pose) assert.ok(Number.isFinite(v));
  assert.ok(pose[1] > 0.6, "root stays up (kinematic)");
  p.destroy();
});

test("knockdown: released, down, then recovers at 0.3 per second", async () => {
  const p = await createPhysics({ seed: 1 });
  const rd = p.createRagdoll(body);
  rd.knockdown("damage", { part: "spine2", impulse: [0, 0, 80] });
  ticks(p, 0.2 + 2.0 + 1.0);
  assert.equal(rd.state, "knockdown");
  ticks(p, 3.0);
  assert.equal(rd.state, "alive");
  p.destroy();
});

test("every state transition is deterministic", async () => {
  const run = async () => {
    const p = await createPhysics({ seed: 3 });
    const a = p.createRagdoll(body, { position: [-0.5, 0, 0] }), b = p.createRagdoll(body, { position: [0.5, 0, 0] });
    const h = [];
    for (let t = 0; t < 300; t++) {
      if (t === 20) a.stagger({ part: "spine2", impulse: [0, 0, 25] });
      if (t === 100) b.kill({ part: "head", impulse: [10, 0, 30] });
      if (t === 150) a.knockdown("push");
      p.step(TICK); h.push(p.hash());
    }
    p.destroy();
    return h;
  };
  assert.deepEqual(await run(), await run());
});
