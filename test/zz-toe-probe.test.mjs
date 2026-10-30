// TEMPORARY probe (not for merge): toe sink under row variants (mass, joint) over ten drop heights.
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createPhysics, generateRow, loadTable } from "../src/index.mjs";
import { qrot } from "../src/math.mjs";

const measure = (n) => JSON.parse(readFileSync(new URL(`../data/bodies/${n}.measure.json`, import.meta.url), "utf8"));
const DROPS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
const VARIANTS = {
  base: () => {},
  mass_x3: (row) => row.roles.forEach((r) => { if (/^toe/.test(r.role)) r.mass_kg *= 3; }),
  mass_x8: (row) => row.roles.forEach((r) => { if (/^toe/.test(r.role)) r.mass_kg *= 8; }),
  swing60: (row) => row.roles.forEach((r) => { if (/^toe/.test(r.role)) r.joint = { ...r.joint, swing_deg: 60 }; }),
  swing15: (row) => row.roles.forEach((r) => { if (/^toe/.test(r.role)) r.joint = { ...r.joint, swing_deg: 15 }; }),
  radius_x1_5: (row) => row.roles.forEach((r) => { if (/^toe/.test(r.role)) r.radius_m *= 1.5; }),
};

test("probe toe sink variants", async () => {
  for (const [name, mod] of Object.entries(VARIANTS)) {
    let worst = 0, worstPart = "", worstDrop = 0;
    for (const drop of DROPS) {
      const p = await createPhysics({ seed: 1 });
      const row = generateRow("v", measure("vagrant-106"), loadTable());
      mod(row);
      const rd = p.createRagdoll(row, { position: [0, drop, 0], id: "v" });
      rd.kill();
      for (let t = 0; t < 1200 && rd.awake; t++) p.step(1 / 60);
      const pose = rd.readPose();
      rd.row.roles.forEach((r, i) => {
        const o = i * 10, q = [pose[o + 3], pose[o + 4], pose[o + 5], pose[o + 6]], ax = qrot(q, [0, 1, 0]);
        let low = Infinity;
        for (const s of [-1, 1]) low = Math.min(low, pose[o + 1] + ax[1] * r.half_height_m * s - r.radius_m);
        if (low < worst) { worst = low; worstPart = r.id; worstDrop = drop; }
      });
      p.destroy();
    }
    console.log("PROBE", name, "worst", worst.toFixed(4), worstPart, "at drop", worstDrop);
  }
});
