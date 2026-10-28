import { readFileSync } from "node:fs";
import { createPhysics } from "../src/index.mjs";
const body = JSON.parse(readFileSync(new URL("../test/fixtures/body-0002.measure.json", import.meta.url), "utf8"));
const run = async (mk, kill = true) => {
  const physics = await createPhysics({ seed: 3 });
  const rd = mk(physics);
  for (let t = 0; t < 10; t++) physics.step(1 / 60);
  if (kill) rd.kill({ part: "spine2", impulse: [0, 0, 60] });
  for (let t = 0; t < 120; t++) physics.step(1 / 60);
  const p = Array.from(rd.readPose()); physics.destroy(); return p;
};
const err = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) if (i % 10 < 3) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
for (const at of [[200, 0, -150], [0, 0, 0], [20, 0, -15]]) {
  for (const kill of [true, false]) {
    const fresh = (p) => (w) => w.createRagdoll(body, { position: p, id: "a" });
    const f0 = await run(fresh(at), kill);
    const f1 = await run(fresh([at[0] + 1e-4, at[1], at[2]]), kill);
    const f2 = await run(fresh([at[0], at[1], at[2] - 1e-4]), kill);
    const ac = await run((w) => { const r = w.createRagdoll(body, { position: [0, 0, 0], id: "a", parked: true }); r.acquire(at); return r; }, kill);
    const ac2 = await run((w) => { const r = w.createRagdoll(body, { position: at, id: "a", parked: true }); r.acquire(); return r; }, kill);
    console.log(`at ${at} kill ${kill}: control fresh vs fresh+1e-4 x ${err(f0, f1).toExponential(2)}, z ${err(f0, f2).toExponential(2)} | acquire(at) from origin vs fresh ${err(f0, ac).toExponential(2)} | parked created AT target, acquire() vs fresh ${err(f0, ac2).toExponential(2)}`);
  }
}
