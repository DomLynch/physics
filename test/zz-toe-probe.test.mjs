// TEMPORARY probe (not for merge): time series of the toe clearance, and toe-vs-foot angle, for the worst drops.
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createPhysics } from "../src/index.mjs";
import { qrot } from "../src/math.mjs";

const measure = (n) => JSON.parse(readFileSync(new URL(`../data/bodies/${n}.measure.json`, import.meta.url), "utf8"));
const low = (pose, r, i) => {
  const o = i * 10, ax = qrot([pose[o + 3], pose[o + 4], pose[o + 5], pose[o + 6]], [0, 1, 0]);
  return Math.min(...[-1, 1].map((s) => pose[o + 1] + ax[1] * r.half_height_m * s - r.radius_m));
};
const axis = (pose, i) => { const o = i * 10; return qrot([pose[o + 3], pose[o + 4], pose[o + 5], pose[o + 6]], [0, 1, 0]); };

test("probe toe trace", async () => {
  for (const drop of [0.5, 0.2]) {
    const p = await createPhysics({ seed: 1 });
    const rd = p.createRagdoll(measure("vagrant-106"), { position: [0, drop, 0], id: "v" });
    rd.kill();
    const roles = rd.row.roles, ti = roles.findIndex((r) => r.id === "toeRight"), fi = roles.findIndex((r) => r.id === "footRight");
    for (let t = 0; t < 1200 && rd.awake; t++) {
      p.step(1 / 60);
      if (t % 15 === 0 || !rd.awake) {
        const pose = rd.readPose(), a = axis(pose, ti), b = axis(pose, fi);
        const ang = (Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI;
        const sp = Math.hypot(pose[ti * 10 + 7], pose[ti * 10 + 8], pose[ti * 10 + 9]);
        console.log("PROBE drop", drop, "t", (t / 60).toFixed(2), "toe_low", low(pose, roles[ti], ti).toFixed(4), "foot_low", low(pose, roles[fi], fi).toFixed(4), "toe_foot_angle", ang.toFixed(0), "toe_axis_y", a[1].toFixed(2), "foot_axis_y", b[1].toFixed(2), "toe_speed", sp.toFixed(3), "state", rd.state);
      }
    }
    p.destroy();
  }
});
