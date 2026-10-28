// Fall sanity trace and 1 / 3 body budget for the chain bodies (salamander, eel, wolf, rat-king, crow).
// Usage: node tools/chain-fall-trace.mjs [--out result.json]   (prints one line "TRACE_JSON {...}" so a job log carries the result; CPU timings are whatever CPU runs it)
// Trace: stand 30 ticks, kill with a hit on the chest and an impulse of (total mass) N*s forward, run 900 ticks: hips height before / after, lowest part y, top speed, finite, state.
import { readFileSync, writeFileSync } from "node:fs";
import { createPhysics, loadChainBody } from "../src/index.mjs";
import { runBudget } from "./budget-seven.mjs";

const NAMES = ["salamander", "eel", "wolf", "rat-king", "crow"];
const SETS = { salamander: "salamander_x7", eel: "eel_x7", wolf: "wolf_x7", "rat-king": "rat_king_x7", crow: "crow_x7" };

async function trace(name) {
  const p = await createPhysics({ seed: 1 });
  const { row } = loadChainBody(name);
  const rd = p.createRagdoll(row, { id: name });
  const n = row.roles.length;
  for (let t = 0; t < 30; t++) p.step(1 / 60);
  const hips0 = rd.readPose()[1];
  rd.kill({ part: row.roles.some((r) => r.id === "chest") ? "chest" : "chest_a", impulse: [0, 0, row.total_mass_kg] });
  let finite = true, lowest = Infinity, peak = 0;
  for (let t = 0; t < 900; t++) {
    p.step(1 / 60);
    const pose = rd.readPose();
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 10; k++) if (!Number.isFinite(pose[i * 10 + k])) finite = false;
      lowest = Math.min(lowest, pose[i * 10 + 1]);
      peak = Math.max(peak, Math.hypot(pose[i * 10 + 7], pose[i * 10 + 8], pose[i * 10 + 9]));
    }
  }
  const pose = rd.readPose();
  let speed = 0;
  for (let i = 0; i < n; i++) speed = Math.max(speed, Math.hypot(pose[i * 10 + 7], pose[i * 10 + 8], pose[i * 10 + 9]));
  const out = { name, parts: n, mass_kg: row.total_mass_kg, hips_y_before_m: hips0, hips_y_after_m: pose[1], lowest_part_y_m: lowest, max_speed_during_m_s: peak, max_speed_at_end_m_s: speed, finite, state: rd.state };
  p.destroy();
  return out;
}

const args = process.argv.slice(2), oi = args.indexOf("--out");
const traces = [];
for (const n of NAMES) traces.push(await trace(n));
const rows = JSON.parse(readFileSync(new URL("../data/budget-rows.json", import.meta.url), "utf8"));
const budget = await runBudget(rows, { counts: [1, 3], sets: Object.values(SETS), scenarios: ["alive_idle", "dying_all_cut"], repeats: 3 });
const res = { schema: "chain-fall-trace/1", node: process.version, cpus: budget.cpus, budget_ms: budget.budget_ms, traces, budget: budget.cells.map((c) => ({ set: c.set, scenario: c.scenario, n: c.n, avg_ms: c.avg_ms, p95_ms: c.p95_ms, max_ms: c.max_ms, deterministic: c.deterministic })) };
if (oi >= 0) writeFileSync(args[oi + 1], JSON.stringify(res, null, 2) + "\n");
console.log("TRACE_JSON " + JSON.stringify(res));
for (const t of traces) console.log(`# ${t.name}: hips ${t.hips_y_before_m.toFixed(3)} -> ${t.hips_y_after_m.toFixed(3)} m, lowest y ${t.lowest_part_y_m.toFixed(3)}, peak ${t.max_speed_during_m_s.toFixed(2)} m/s, end ${t.max_speed_at_end_m_s.toFixed(3)} m/s, finite ${t.finite}, ${t.state}`);
for (const c of res.budget) console.log(`# ${c.set} ${c.scenario} n=${c.n}: avg ${c.avg_ms.toFixed(3)} p95 ${c.p95_ms.toFixed(3)} max ${c.max_ms.toFixed(3)} ms`);
