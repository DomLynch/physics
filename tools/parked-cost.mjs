// Cost of parked (pooled, idle) ragdolls: ms per world.step with N humanoid ragdolls created the way the game's pool does it
// (position [0,0,0], an id string, never killed), N = 0, 6, 30; plus a scale row, 3 dying ragdolls.
// Usage: node tools/parked-cost.mjs [--body minotaur-106] [--parked] [--counts 0,6,30] [--repeats 3] [--ticks 600] [--warm 60]
// --parked passes { parked: true } to createRagdoll (ignored by a package without that option). Prints one "PARKED_COST_JSON {...}" line.
// This is CPU physics-step time on whatever machine runs it. It is NOT a phone and NOT GPU cost. src/ never reads a clock; the timing lives here.
import { readFileSync } from "node:fs";
import { createPhysics } from "../src/index.mjs";

const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i < 0 ? d : process.argv[i + 1]; };
const flag = (k) => process.argv.includes("--" + k);
const bodyName = arg("body", "minotaur-106"), parked = flag("parked");
const counts = arg("counts", "0,6,30").split(",").map(Number), repeats = +arg("repeats", 3), ticks = +arg("ticks", 600), warm = +arg("warm", 60);
const row = JSON.parse(readFileSync(new URL(`../data/bodies/${bodyName}.measure.json`, import.meta.url), "utf8"));

const pct = (s, p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
const summarize = (t) => { const s = [...t].sort((a, b) => a - b); return { avg_ms: s.reduce((a, b) => a + b, 0) / s.length, p95_ms: pct(s, 0.95), max_ms: s[s.length - 1] }; };

// n parked ragdolls (the pool), plus `dying` live ones killed on the first measured tick
export async function runCell(n, dying = 0) {
  const physics = await createPhysics({ seed: 1 });
  const pool = [];
  for (let i = 0; i < n; i++) pool.push(physics.createRagdoll(row, parked ? { position: [0, 0, 0], id: "pool" + i, parked: true } : { position: [0, 0, 0], id: "pool" + i }));
  const live = [];
  for (let i = 0; i < dying; i++) live.push(physics.createRagdoll(row, { position: [(i - (dying - 1) / 2) * 2, 0, 0], id: "live" + i }));
  const times = [];
  for (let t = 0; t < warm + ticks; t++) {
    if (t === warm) for (const r of live) r.kill({ part: "spine2", impulse: [0, 0, 40] });
    const t0 = performance.now();
    physics.step(1 / 60);
    const dt = performance.now() - t0;
    if (t >= warm) times.push(dt);
  }
  const hash = physics.hash();
  physics.destroy();
  return { ...summarize(times), hash };
}

const out = { body: bodyName, parked, node: process.version, platform: process.platform, ticks, warm, repeats, cells: [] };
await runCell(6); // JIT / WASM warm-up, not recorded
for (const [label, n, dying] of [...counts.map((c) => [`parked${c}`, c, 0]), ["dying3", 0, 3]]) {
  const runs = [];
  for (let r = 0; r < repeats; r++) runs.push(await runCell(n, dying));
  const mean = (k) => runs.reduce((a, b) => a + b[k], 0) / runs.length;
  const cell = { label, parked_n: n, dying, avg_ms: mean("avg_ms"), p95_ms: mean("p95_ms"), max_ms: Math.max(...runs.map((x) => x.max_ms)), runs };
  out.cells.push(cell);
  console.log(`${label.padEnd(9)} avg ${cell.avg_ms.toFixed(3)} ms  p95 ${cell.p95_ms.toFixed(3)} ms  max ${cell.max_ms.toFixed(3)} ms   (repeats avg: ${runs.map((x) => x.avg_ms.toFixed(3)).join(" / ")})`);
}
const base = out.cells.find((c) => c.parked_n === 0 && !c.dying), dy = out.cells.find((c) => c.dying);
for (const c of out.cells) if (!c.dying) c.over_empty_avg_ms = c.avg_ms - base.avg_ms;
console.log("PARKED_COST_JSON " + JSON.stringify(out));
const d = dy.avg_ms - base.avg_ms;
for (const c of out.cells) if (!c.dying && c.parked_n) console.log(`${c.label}: +${c.over_empty_avg_ms.toFixed(3)} ms avg over empty = ${(100 * c.over_empty_avg_ms / d).toFixed(0)}% of the 3-dying cost (+${d.toFixed(3)} ms)`);
