// Replay a recorded fight (V3's per-tick root + target pose dump) through the package and report tracking error per role.
//   node tools/replay-poses.mjs <poses.json> <body.measure.json> ['{"motorGain":2,"motorDamping":0.25,"solveHinges":false}'] [--settled N] [--frames N]
// live = error after the normal tick; settled = after N extra ticks toward the same pose (removes lag). Error is the angle between each capsule and its target:
// full orientation, and long axis only (what remains of "full" is twist). Median and p95 over both sides, in degrees.
import { readFileSync } from "node:fs";
import { createPhysics } from "../src/index.mjs";
import { qrot } from "../src/math.mjs";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf("--" + n); return i < 0 ? d : Number(args.splice(i, 2)[1]); };
const settleN = flag("settled", 0), maxFrames = flag("frames", Infinity);
const [posesFile, bodyFile, optsJson] = args;
const dump = JSON.parse(readFileSync(posesFile, "utf8")), body = JSON.parse(readFileSync(bodyFile, "utf8"));
const opts = optsJson ? JSON.parse(optsJson) : {};
const p = await createPhysics({ seed: 1 });
const rd = p.createRagdoll(body, opts);
const ids = rd.partIds;
if (JSON.stringify(ids) !== JSON.stringify(dump.partIds)) throw new Error("partIds differ from the dump");
const ang = (a, b) => (2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * 180) / Math.PI;
const axisAng = (qa, qb) => { const a = qrot(qa, [0, 1, 0]), b = qrot(qb, [0, 1, 0]); return (Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI; };
const group = (id) => (process.env.SIDES ? id : id.replace(/(Left|Right)$/, ""));
const acc = {};
const measure = (frame, tag) => {
  const pose = rd.readPose();
  ids.forEach((id, i) => {
    const q = [pose[i * 10 + 3], pose[i * 10 + 4], pose[i * 10 + 5], pose[i * 10 + 6]], t = frame.target.slice(i * 4, i * 4 + 4);
    const g = group(id), a = (acc[g] ||= { live: [], liveAxis: [], settled: [], settledAxis: [] });
    a[tag].push(ang(q, t)); a[tag + "Axis"].push(axisAng(q, t));
  });
};
const frames = dump.frames.slice(0, maxFrames);
const t0 = process.hrtime.bigint();
for (const f of frames) {
  rd.setRoot(f.root.slice(0, 3), f.root.slice(3, 7));
  rd.setTargetPose(Float32Array.from(f.target));
  p.step(1 / dump.tickHz);
  measure(f, "live");
}
// settled pass: re-run, and after each tick give the ragdoll N more ticks toward the same pose
if (settleN) {
  rd.reset();
  for (const f of frames) {
    rd.setRoot(f.root.slice(0, 3), f.root.slice(3, 7));
    rd.setTargetPose(Float32Array.from(f.target));
    p.step(1 / dump.tickHz);
    for (let k = 0; k < settleN; k++) { rd.setRoot(f.root.slice(0, 3), f.root.slice(3, 7)); p.step(1 / dump.tickHz); }
    measure(f, "settled");
  }
}
const q = (a, f) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(f * s.length))].toFixed(1); };
const cell = (a) => (a.length ? `${q(a, 0.5)} (${q(a, 0.95)})` : "-");
console.log(`options ${JSON.stringify(opts)}  frames ${frames.length}  ${(Number(process.hrtime.bigint() - t0) / 1e9).toFixed(1)} s`);
console.log("role".padEnd(10), "live full".padEnd(14), "live axis".padEnd(14), settleN ? "settled full".padEnd(14) + "settled axis" : "");
for (const g of Object.keys(acc)) console.log(g.padEnd(10), cell(acc[g].live).padEnd(14), cell(acc[g].liveAxis).padEnd(14), settleN ? cell(acc[g].settled).padEnd(14) + cell(acc[g].settledAxis) : "");
p.destroy();
