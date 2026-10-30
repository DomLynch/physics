// TEMPORARY probe (not for merge): toe radius ratio vs toe sink, several humanoid bodies, flat + slope15.
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createPhysics, generateRow, loadTable } from "../src/index.mjs";
import { qrot } from "../src/math.mjs";

const measure = (n) => JSON.parse(readFileSync(new URL(`../data/bodies/${n}.measure.json`, import.meta.url), "utf8"));
const DROPS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
const RATIOS = [0.02, 0.015, 0.012, 0.01, 0.008];
const BODIES = ["vagrant-106", "brute-106", "big-vegas-106", "anime-girl-blonde-106"];

for (const ground of [undefined, "slope15"]) for (const body of BODIES) test(`probe ${body} ${ground}`, async () => {
  for (const ratio of RATIOS) {
    let worstToe = 0, worstAny = 0, worstAnyPart = "", rr = 0;
    for (const drop of DROPS) {
      const p = await createPhysics({ seed: 1, ...(ground ? { ground } : {}) });
      const t = structuredClone(loadTable()); t.roles.find((r) => r.id === "toe").r.fixed_height_ratio = ratio;
      const row = generateRow("v", measure(body), t);
      rr = row.roles.find((r) => r.id === "toeRight").radius_m;
      const rd = p.createRagdoll(row, { position: [0, (ground ? p.groundMax(0, 0, 0.5) : 0) + drop, 0], id: "v" });
      rd.kill();
      for (let k = 0; k < 1200 && rd.awake; k++) p.step(1 / 60);
      const pose = rd.readPose();
      rd.row.roles.forEach((r, i) => {
        const o = i * 10, ax = qrot([pose[o + 3], pose[o + 4], pose[o + 5], pose[o + 6]], [0, 1, 0]);
        for (const s of [-1, 1]) {
          const c = [pose[o] + ax[0] * r.half_height_m * s, pose[o + 1] + ax[1] * r.half_height_m * s, pose[o + 2] + ax[2] * r.half_height_m * s];
          const n = p.groundNormal(c[0], c[2]);
          const low = (c[1] - p.groundHeight(c[0], c[2])) * n[1] - r.radius_m;
          if (/^toe/.test(r.id)) worstToe = Math.min(worstToe, low);
          if (low < worstAny) { worstAny = low; worstAnyPart = r.id; }
        }
      });
      p.destroy();
    }
    console.log("PROBE", ground || "flat", body, "ratio", ratio, "toe_r", rr.toFixed(4), "worst_toe", worstToe.toFixed(4), "worst_any", worstAny.toFixed(4), worstAnyPart);
  }
});
