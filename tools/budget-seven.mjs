// Per-frame CPU physics-step cost for N = 1..7 simultaneous ragdolls, with and without cuts, from the rows in data/budget-rows.json.
// Usage: node tools/budget-seven.mjs [rows.json] [--out results.json]   (prints one line "BUDGET_JSON {...}" so a job log carries the result)
// This is the cost of one 60 Hz tick (motors + Jolt step + readPose) on whatever CPU runs it. It is NOT GPU render cost. src/ never reads a clock; the timing lives here.
import { readFileSync, writeFileSync } from "node:fs";
import { createPhysics } from "../src/index.mjs";

const ROWS_URL = new URL("../data/budget-rows.json", import.meta.url);
const loadBody = (name) => JSON.parse(readFileSync(new URL(`../data/bodies/${name}.measure.json`, import.meta.url), "utf8"));

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
export function summarize(times) {
  const s = [...times].sort((a, b) => a - b);
  return { frames: s.length, avg_ms: s.reduce((a, b) => a + b, 0) / s.length, p50_ms: pct(s, 0.5), p95_ms: pct(s, 0.95), p99_ms: pct(s, 0.99), max_ms: s[s.length - 1] };
}

// one cell: n ragdolls of `set`, one scenario. Returns the timings and the world hash (equal across repeats = deterministic).
export async function runCell(rows, set, scenario, n, over = {}) {
  const ticks = over.ticks ?? rows.ticks, warm = over.warm_ticks ?? rows.warm_ticks, M = rows.motor_strength;
  const physics = await createPhysics({ seed: 1 });
  const rds = set.bodies.slice(0, n).map((b, k) => physics.createRagdoll(loadBody(b), { position: [(k - (n - 1) / 2) * rows.spacing_m, 0, 0], id: "b" + k }));
  const who = scenario.cut_who === "all" ? n : Math.min(n, scenario.cut_who ?? n);
  const times = [];
  let cuts = 0;
  for (let t = 0; t < ticks; t++) {
    const t0 = performance.now();
    for (const c of scenario.cuts) if (c.tick === t) for (let k = 0; k < who; k++) if (rds[k].cut(c.unit)) cuts++;
    if (scenario.kill && scenario.kill.tick === t) for (const r of rds) r.kill({ part: scenario.kill.part, impulse: scenario.kill.impulse });
    if (!scenario.kill || t < scenario.kill.tick) for (const r of rds) r.setMotorStrength({ all: t % M.period_ticks < M.high_ticks ? M.high : M.low });
    physics.step(1 / 60);
    for (const r of rds) r.readPose();
    if (t >= warm) times.push(performance.now() - t0);
  }
  const hash = physics.hash();
  physics.destroy();
  return { times, hash, cuts };
}

export async function runBudget(rows = JSON.parse(readFileSync(ROWS_URL, "utf8")), over = {}) {
  const repeats = over.repeats ?? rows.repeats, counts = over.counts ?? rows.counts;
  const sets = over.sets ? rows.sets.filter((s) => over.sets.includes(s.id)) : rows.sets;
  const scenarios = over.scenarios ? rows.scenarios.filter((s) => over.scenarios.includes(s.id)) : rows.scenarios;
  const cells = [];
  for (const set of sets) for (const scenario of scenarios) for (const n of counts) {
    if (n > set.bodies.length) continue;
    const all = [], hashes = new Set();
    let cuts = 0;
    for (let r = 0; r < repeats; r++) { const c = await runCell(rows, set, scenario, n, over); all.push(...c.times); hashes.add(c.hash); cuts = c.cuts; }
    cells.push({ set: set.id, scenario: scenario.id, n, cuts, repeats, deterministic: hashes.size === 1, ...summarize(all) });
  }
  return { schema: "budget-results/1", budget_ms: rows.budget_ms, ticks: over.ticks ?? rows.ticks, node: process.version, cpus: (await import("node:os")).cpus().length, cells };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2), oi = args.indexOf("--out");
  const out = oi >= 0 ? args.splice(oi, 2)[1] : null;
  const rows = args[0] ? JSON.parse(readFileSync(args[0], "utf8")) : undefined;
  const res = await runBudget(rows);
  if (out) writeFileSync(out, JSON.stringify(res, null, 2) + "\n");
  console.log("BUDGET_JSON " + JSON.stringify(res));
  for (const c of res.cells) console.log(`# ${c.set} ${c.scenario} n=${c.n}: avg ${c.avg_ms.toFixed(3)} p95 ${c.p95_ms.toFixed(3)} max ${c.max_ms.toFixed(3)} ms${c.deterministic ? "" : " NONDETERMINISTIC"}`);
}
