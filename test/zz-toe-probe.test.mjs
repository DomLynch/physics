// TEMPORARY probe (not for merge): which data row removes the toe sink (worst over ten drops, vagrant-106, default floor + slope15).
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createPhysics, generateRow, loadTable } from "../src/index.mjs";
import { qrot } from "../src/math.mjs";

const measure = (n) => JSON.parse(readFileSync(new URL(`../data/bodies/${n}.measure.json`, import.meta.url), "utf8"));
const DROPS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
const T = (f) => () => { const t = loadTable(); f(t); return t; };
const toeRole = (t) => t.roles.find((r) => r.id === "toe");
const VARIANTS = {
  base: [{}, T(() => {})],
  iters12: [{ rows: { velocity_iterations: 12 } }, T(() => {})],
  iters24: [{ rows: { velocity_iterations: 24 } }, T(() => {})],
  toe_ext_0_02: [{}, T((t) => { t.reference.toe_ext_height_ratio = 0.02; })],
  toe_ext_0: [{}, T((t) => { t.reference.toe_ext_height_ratio = 0; })],
  toe_r_0_03: [{}, T((t) => { toeRole(t).r.fixed_height_ratio = 0.03; })],
  toe_r_0_012: [{}, T((t) => { toeRole(t).r.fixed_height_ratio = 0.012; })],
};

for (const ground of [undefined, "slope15"]) test(`probe toe variants ground=${ground}`, async () => {
  for (const [name, [popts, mk]] of Object.entries(VARIANTS)) {
    let worst = 0, worstPart = "", worstDrop = 0, mass = 0;
    for (const drop of DROPS) {
      const p = await createPhysics({ seed: 1, ...popts, ...(ground ? { ground } : {}) });
      const row = generateRow("v", measure("vagrant-106"), mk());
      mass = row.roles.find((r) => r.id === "toeRight").radius_m;
      const rd = p.createRagdoll(row, { position: [0, (ground ? p.groundMax(0, 0, 0.5) : 0) + drop, 0], id: "v" });
      rd.kill();
      for (let t = 0; t < 1200 && rd.awake; t++) p.step(1 / 60);
      const pose = rd.readPose();
      rd.row.roles.forEach((r, i) => {
        const o = i * 10, ax = qrot([pose[o + 3], pose[o + 4], pose[o + 5], pose[o + 6]], [0, 1, 0]);
        for (const s of [-1, 1]) {
          const c = [pose[o] + ax[0] * r.half_height_m * s, pose[o + 1] + ax[1] * r.half_height_m * s, pose[o + 2] + ax[2] * r.half_height_m * s];
          const n = p.groundNormal(c[0], c[2]);
          const low = (c[1] - p.groundHeight(c[0], c[2])) * n[1] - r.radius_m;
          if (low < worst) { worst = low; worstPart = r.id; worstDrop = drop; }
        }
      });
      p.destroy();
    }
    console.log("PROBE", ground || "flat", name, "worst", worst.toFixed(4), worstPart, "at drop", worstDrop, "toe_r", mass.toFixed(4));
  }
});
