// TEMPORARY probe (not for merge): which part sinks, by how much, and what the engine built for the toe.
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createPhysics } from "../src/index.mjs";
import { qrot } from "../src/math.mjs";

const measure = (n) => JSON.parse(readFileSync(new URL(`../data/bodies/${n}.measure.json`, import.meta.url), "utf8"));

test("probe toe sink", async () => {
  for (const drop of [0.1, 0.4, 1.0]) {
    const p = await createPhysics({ seed: 1 });
    const row0 = measure("vagrant-106");
    const rd = p.createRagdoll(row0, { position: [0, drop, 0], id: "v" });
    const row = rd.row;
    rd.kill();
    for (let t = 0; t < 1200 && rd.awake; t++) p.step(1 / 60);
    const pose = rd.readPose();
    const out = [];
    row.roles.forEach((r, i) => {
      const o = i * 10, q = [pose[o + 3], pose[o + 4], pose[o + 5], pose[o + 6]], ax = qrot(q, [0, 1, 0]);
      let low = Infinity;
      for (const s of [-1, 1]) low = Math.min(low, pose[o + 1] + ax[1] * r.half_height_m * s - r.radius_m);
      out.push([r.id, +low.toFixed(4), "r", r.radius_m, "hh", r.half_height_m, "m", r.mass_kg, "vy_axis", +ax[1].toFixed(2)]);
    });
    out.sort((a, b) => a[1] - b[1]);
    console.log("PROBE drop", drop, JSON.stringify(out.slice(0, 5)));
    console.log("PROBE roleKeys", Object.keys(row.roles[0]).join(","));
    p.destroy();
  }
});
