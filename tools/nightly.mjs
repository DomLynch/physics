// Nightly physics benchmark: runs the cells listed in data/nightly-rows.json `runs` times (5), each run a fresh process that warms up first, and keeps the p95 of the per-frame times of all runs pooled
// (the same definition as tools/budget-seven.mjs, so the two agree; see `calibration` in the rows file). The parked cell has no frames: it keeps the median of its runs' p95.
// Usage: node tools/nightly.mjs [--out results.json] [--target name] [--runs 5] [--rows data/nightly-rows.json]   (prints one "NIGHTLY_JSON {...}" line so a job log carries the result)
// A cell whose tooling or data is absent at the checked-out sha (an old pin without admit(), loadChainBody(), a body file, or a tool) is SKIPPED, never failed. Run an older pin's src/ and data/ with the CURRENT tools/
// (scripts/physics-nightly.sh does the overlay). This is the CPU cost of one 60 Hz physics tick on whatever machine runs it; src/ never reads a clock, the timing lives here.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { availableParallelism } from "node:os";
import * as P from "../src/index.mjs";
import { runCell } from "./budget-seven.mjs";
import { cellKey, medianCells, pooledCells, SCHEMA } from "./nightly-gate.mjs";

const WARM_RUNS = 2; // unrecorded full runs of a cell before the recorded one, in the same process: a fresh node process times its first 200 frames on a cold JIT, which is not what budget-seven measures
const ROOT = new URL("../", import.meta.url);

// the reason a cell cannot run here, or null
function whyNot(cell, br) {
  if (cell.kind === "parked") return existsSync(new URL(cell.needs, ROOT)) ? null : `${cell.needs} absent`;
  const set = br.sets.find((s) => s.id === cell.set);
  if (!set) return `set ${cell.set} absent`;
  if (!br.scenarios.some((s) => s.id === cell.scenario)) return `scenario ${cell.scenario} absent`;
  if (set.kind === "chain" && typeof P.loadChainBody !== "function") return "loadChainBody absent";
  if (cell.cap && typeof P.admit !== "function") return "admit absent";
  return null;
}

// one timed run of one cell -> p95_ms
async function once(cell, br, over) {
  if (cell.kind === "parked") {
    const out = execFileSync(process.execPath, [new URL(cell.needs, ROOT).pathname, "--parked", "--counts", `0,${cell.n}`, "--repeats", "1"], { encoding: "utf8", maxBuffer: 1 << 26 });
    const line = out.split("\n").find((l) => l.startsWith("PARKED_COST_JSON "));
    const c = JSON.parse(line.slice("PARKED_COST_JSON ".length)).cells.find((x) => x.parked_n === cell.n && !x.dying);
    return c.p95_ms;
  }
  const set = br.sets.find((s) => s.id === cell.set), scenario = br.scenarios.find((s) => s.id === cell.scenario);
  const res = await runCell({ ...br, ...(over.ticks ? { ticks: over.ticks } : {}), ...(over.warm_ticks ? { warm_ticks: over.warm_ticks } : {}) }, set, scenario, cell.n, { apply_cap: !!cell.cap });
  return res.times; // the per-frame step times after the scenario's own warm ticks; the p95 is taken over the frames of all runs pooled (tools/nightly-gate.mjs pooledCells)
}

// the same, in a fresh node process: a Jolt WASM abort (OOM on an old pin, say) kills only that cell's run, not the rest of the night
function onceIsolated(cell, over) {
  const a = [new URL(import.meta.url).pathname, "--cell", JSON.stringify(cell)];
  if (over.ticks) a.push("--ticks", String(over.ticks));
  if (over.warm_ticks) a.push("--warm", String(over.warm_ticks));
  const r = spawnSync(process.execPath, a, { encoding: "utf8", maxBuffer: 1 << 26 });
  const m = /^CELL_FRAMES (.+)$/m.exec(r.stdout || "");
  if (r.status !== 0 || !m) throw new Error((r.stderr || "").trim().split("\n").pop() || `child exited ${r.status}`);
  return JSON.parse(m[1]);
}

// nr: the nightly rows, br: the budget rows. over: { runs, ticks, warm_ticks, target, sha, date }. Runs are interleaved across cells so slow drift on the box hits every cell alike.
export async function runNightly(nr, br, over = {}) {
  const runs = over.runs ?? nr.runs, skipped = [], skip_reasons = {}, live = [], perRun = Array.from({ length: runs }, () => ({}));
  for (const cell of nr.cells) {
    const why = whyNot(cell, br), key = cellKey(cell);
    if (why) { skipped.push(key); skip_reasons[key] = why; } else live.push(cell);
  }
  const dead = new Set();
  const run1 = (cell) => (over.isolate ? onceIsolated(cell, over) : once(cell, br, over));
  const warm = live.find((c) => c.kind !== "parked");
  if (warm && !over.isolate) try { await once(warm, br, { ticks: 30, warm_ticks: 5 }); } catch { /* JIT and WASM warm-up only, not recorded */ }
  for (let r = 0; r < runs; r++) for (const cell of live) {
    const key = cellKey(cell);
    if (dead.has(key)) continue;
    try { perRun[r][key] = await run1(cell); }
    catch (e) { dead.add(key); skipped.push(key); skip_reasons[key] = String(e.message || e).split("\n")[0].slice(0, 160); for (const pr of perRun) delete pr[key]; }
  }
  return {
    schema: SCHEMA, target: over.target ?? "local", sha: over.sha ?? "0".repeat(40), date: over.date ?? new Date().toISOString().slice(0, 10),
    node: process.version, cpus: availableParallelism(), runs, limit_ms: nr.limit_ms, regress_pct: nr.regress_pct,
    cells: { ...pooledCells(perRun.map((pr) => Object.fromEntries(Object.entries(pr).filter(([, v]) => Array.isArray(v))))), ...medianCells(perRun.map((pr) => Object.fromEntries(Object.entries(pr).filter(([, v]) => !Array.isArray(v))))) }, skipped: skipped.sort(), skip_reasons,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf("--" + k); return i < 0 ? d : args[i + 1]; };
  if (opt("cell")) { // child mode: WARM_RUNS unrecorded full runs of the cell (JIT and WASM warm, like budget-seven's repeats in one process), then one recorded run; prints CELL_FRAMES [ms...] (parked: the p95)
    const cell = JSON.parse(opt("cell")), br = JSON.parse(readFileSync(new URL("../data/budget-rows.json", import.meta.url), "utf8"));
    const over = { ticks: opt("ticks") ? +opt("ticks") : undefined, warm_ticks: opt("warm") ? +opt("warm") : undefined };
    try {
      if (cell.kind !== "parked") for (let i = 0; i < WARM_RUNS; i++) await once(cell, br, over);
      const v = await once(cell, br, over);
      console.log("CELL_FRAMES " + JSON.stringify(Array.isArray(v) ? v.map((x) => +x.toFixed(4)) : v));
    } catch (e) { console.error(String(e.message || e).split("\n")[0]); process.exit(1); }
    process.exit(0);
  }
  const nr = JSON.parse(readFileSync(opt("rows", new URL("../data/nightly-rows.json", import.meta.url)), "utf8"));
  const br = JSON.parse(readFileSync(new URL("../data/budget-rows.json", import.meta.url), "utf8"));
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT.pathname, encoding: "utf8" }).trim();
  const res = await runNightly(nr, br, { isolate: true, runs: opt("runs") ? +opt("runs") : undefined, target: opt("target", "local"), sha });
  const out = opt("out");
  if (out) writeFileSync(out, JSON.stringify(res, null, 2) + "\n");
  console.log("NIGHTLY_JSON " + JSON.stringify(res));
  for (const [k, c] of Object.entries(res.cells)) console.log(`# ${k}: p95 ${c.p95_ms.toFixed(3)} ms over ${c.runs} runs${c.frames ? ` (${c.frames} frames pooled)` : ""}`);
  for (const k of res.skipped) console.log(`# ${k}: SKIPPED (${res.skip_reasons[k]})`);
}
