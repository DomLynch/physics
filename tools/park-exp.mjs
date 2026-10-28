import { readFileSync } from "node:fs";
import { createPhysics } from "../src/index.mjs";
const body = JSON.parse(readFileSync(new URL("../test/fixtures/body-0002.measure.json", import.meta.url), "utf8"));
const KILL = { part: "spine2", impulse: [0, 0, 60] };
const run = async (pre) => {
  const p = await createPhysics({ seed: 3 });
  const rd = p.createRagdoll(body, { position: [0.4, 0, 0], id: "a", parked: true });
  const st = (n) => { for (let t = 0; t < n; t++) p.step(1 / 60); };
  pre(rd, st);
  st(20); rd.acquire(); st(10); rd.kill(KILL); st(300);
  const r = Array.from(rd.readPose()); p.destroy(); return r;
};
const d = (a, b) => Math.max(...a.map((x, i) => Math.abs(x - b[i])));
const base = await run(() => {});
console.log("repeat base", d(base, await run(() => {})));
console.log("park immediately after acquire", d(base, await run((rd) => { rd.acquire(); rd.park(); })));
console.log("acquire 10 steps park", d(base, await run((rd, st) => { rd.acquire(); st(10); rd.park(); })));
console.log("fell 400 then park", d(base, await run((rd, st) => { rd.acquire(); st(10); rd.kill(KILL); st(400); rd.park(); })));
console.log("never moved: acquire, park, acquire path", d(base, await run((rd, st) => { rd.acquire(); rd.park(); st(5); })));
