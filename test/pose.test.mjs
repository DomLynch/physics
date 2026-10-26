// setTargetPose: the motors drive the arm chain from the T-pose to arms-down, and the capsules end up near the commanded orientation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPhysics } from "../src/index.mjs";
import { qmul } from "../src/math.mjs";

const body = JSON.parse(readFileSync(new URL("../data/bodies/minotaur.measure.json", import.meta.url), "utf8"));
const angleDeg = (a, b) => (2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * 180) / Math.PI;

test("setTargetPose swings the arms down and the capsules reach the commanded orientation", async () => {
  const p = await createPhysics({ seed: 1 });
  const rd = p.createRagdoll(body);
  const roles = rd.row.roles, ang = (60 * Math.PI) / 180, target = new Float32Array(roles.length * 4);
  roles.forEach((r, i) => {
    let q = r.rest.quat;
    if (/^(arm|forearm|hand)(Left|Right)$/.test(r.id)) {
      const s = r.side === "Left" ? -1 : 1, h = (s * ang) / 2; // rotation about world Z: left arm (+X) down, right arm (-X) down
      q = qmul([0, 0, Math.sin(h), Math.cos(h)], r.rest.quat);
    }
    target.set(q, i * 4);
  });
  rd.setTargetPose(target);
  for (let t = 0; t < 180; t++) p.step(1 / 60);
  const pose = rd.readPose();
  for (const id of ["armLeft", "armRight", "forearmLeft", "forearmRight"]) {
    const i = rd.partIds.indexOf(id);
    const err = angleDeg(Array.from(pose.subarray(i * 10 + 3, i * 10 + 7)), Array.from(target.subarray(i * 4, i * 4 + 4)));
    assert.ok(err < 20, `${id} is ${err.toFixed(1)} degrees from its target`);
  }
  p.destroy();
});
