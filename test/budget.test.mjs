// The 3 ms budget (BRIEF): the M3 proof scene is FIVE active 20-body ragdolls, motors on, self-collision on, one cut in progress. This guards it in Node on the
// CI runner (a regression guard, not the phone number: the phone is measured by the bench page in the PR). Also: a standing ragdoll holds its rest pose.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPhysics } from "../src/index.mjs";

const body = JSON.parse(readFileSync(new URL("./fixtures/body-0002.measure.json", import.meta.url), "utf8"));
const BUDGET_MS = Number(process.env.BUDGET_MS || 3);

test("five active ragdolls with one cut in progress: frame under 3 ms (average and p95)", async () => {
  const physics = await createPhysics({ seed: 1 });
  const rds = [0, 1, 2, 3, 4].map((k) => physics.createRagdoll(body, { position: [(k - 2) * 0.9, 0, 0], id: "f" + k }));
  const times = [];
  for (let t = 0; t < 240; t++) {
    if (t === 60) rds[0].cut("arm_right");
    const t0 = performance.now();
    for (const r of rds) r.setMotorStrength({ all: t % 120 < 60 ? 1 : 0.8 });
    physics.step(1 / 60);
    for (const r of rds) r.readPose();
    if (t >= 30) times.push(performance.now() - t0);
  }
  physics.destroy();
  times.sort((a, b) => a - b);
  const avg = times.reduce((a, b) => a + b, 0) / times.length, p95 = times[Math.floor(times.length * 0.95)];
  console.log(`# five fighters + cut: avg ${avg.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms, max ${times[times.length - 1].toFixed(3)} ms (budget ${BUDGET_MS})`);
  assert.ok(avg < BUDGET_MS, `average ${avg} ms`);
  assert.ok(p95 < BUDGET_MS, `p95 ${p95} ms`);
});

test("a standing ragdoll holds its rest pose with the hips kinematic (limits and motors agree)", async () => {
  const physics = await createPhysics({ seed: 1 });
  const rd = physics.createRagdoll(body, { position: [0, 0, 0] });
  const p0 = Float32Array.from(rd.readPose());
  for (let t = 0; t < 120; t++) physics.step(1 / 60);
  const p1 = rd.readPose();
  let worst = 0;
  for (let i = 0; i < rd.partIds.length; i++) worst = Math.max(worst, Math.hypot(p1[i * 10] - p0[i * 10], p1[i * 10 + 1] - p0[i * 10 + 1], p1[i * 10 + 2] - p0[i * 10 + 2]));
  physics.destroy();
  assert.ok(worst < 0.12, `a part drifted ${worst} m from its rest pose in 2 s`);
  for (const v of p1) assert.ok(Number.isFinite(v));
});

test("a limp ragdoll falls to the floor and nothing is NaN", async () => {
  const physics = await createPhysics({ seed: 1 });
  const rd = physics.createRagdoll(body, { position: [0, 0, 0], rootKinematic: false, motorStrength: 0.01 });
  for (let t = 0; t < 300; t++) physics.step(1 / 60);
  const p = rd.readPose();
  physics.destroy();
  for (const v of p) assert.ok(Number.isFinite(v));
  assert.ok(p[1] < 0.2, `hips at ${p[1]} m after 5 s`);
});
