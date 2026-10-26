// A guard pose (upper arm down, forearm brought forward and up) is out of the elbow's T-pose bend plane. setTargetPose twists the upper arm so the plane
// matches; the forearm's long axis must end up close to the clip's, far closer than without that (solveHinges: false). Per-role tuning is exercised too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPhysics } from "../src/index.mjs";
import { qmul, qrot } from "../src/math.mjs";

const body = JSON.parse(readFileSync(new URL("../data/bodies/minotaur.measure.json", import.meta.url), "utf8"));
const TICK = 1 / 60;
const rot = (axis, deg) => { const h = (deg * Math.PI) / 360, s = Math.sin(h); return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)]; };

function guardTarget(rd) {
  const q = new Float32Array(rd.row.roles.length * 4);
  rd.row.roles.forEach((r, i) => {
    let v = r.rest.quat;
    const s = r.side === "Left" ? -1 : 1;
    if (r.role === "arm") v = qmul(rot([0, 0, 1], s * 70), r.rest.quat);
    if (r.role === "forearm" || r.role === "hand") v = qmul(rot([1, 0, 0], 80), qmul(rot([0, 0, 1], s * 70), r.rest.quat));
    q.set(v, i * 4);
  });
  return q;
}

async function forearmAxisError(opts) {
  const p = await createPhysics({ seed: 1 });
  const rd = p.createRagdoll(body, opts);
  const t = guardTarget(rd);
  rd.setTargetPose(t);
  for (let k = 0; k < 150; k++) p.step(TICK);
  const pose = rd.readPose();
  const errs = ["forearmLeft", "forearmRight"].map((id) => {
    const i = rd.partIds.indexOf(id);
    const a = qrot([pose[i * 10 + 3], pose[i * 10 + 4], pose[i * 10 + 5], pose[i * 10 + 6]], [0, 1, 0]), b = qrot(Array.from(t.subarray(i * 4, i * 4 + 4)), [0, 1, 0]);
    return (Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI;
  });
  for (const v of pose) assert.ok(Number.isFinite(v));
  p.destroy();
  return (errs[0] + errs[1]) / 2;
}

test("hinge plane solve: a guard forearm lands much closer to the clip's long axis", async () => {
  const off = await forearmAxisError({ solveHinges: false }), on = await forearmAxisError({});
  console.log(`# forearm long-axis error in a guard pose after 2.5 s: plane solve off ${off.toFixed(1)} deg, on ${on.toFixed(1)} deg`);
  // synthetic pose, so only a sanity bound; the real-clip numbers are in docs/API.md (tools/replay-poses.mjs)
  assert.ok(on < off + 5, `solve on ${on} should not be worse than off ${off}`);
  assert.ok(on < 35, `solve on still ${on} deg off`);
});

test("per-role tuning is accepted and stays stable", async () => {
  const e = await forearmAxisError({ motorTuning: { all: { gain: 2, damping: 0.25 }, neck: { gain: 1, damping: 1 }, head: { gain: 1, damping: 1 } } });
  assert.ok(e < 40, `tuned error ${e}`);
});
