// M4 measurement: tip speed of swings in a recorded fight (V3's per-tick root + 20 capsule target quaternions).
//   node tools/tip-speed.mjs <poses.json> <body.measure.json> [--start 2.0] [--gap 0.15] [--json out.json] [--series out.csv]
// Forward kinematics is the same chain as snapToTarget (src/engine.mjs): pivot[i] = pivot[parent] + delta[parent] * (rest pivot[i] - rest pivot[parent]),
// delta[i] = target[i] * conj(rest quat[i]), hips centre = the root position. Tip = the far end of the hand capsule (hand pivot + hand length along its axis).
// Measured quantity = HAND speed. Weapon tip speed = hand speed x lever, lever = (arm reach + weapon length) / arm reach (the weapon continues the arm
// and the whole chain turns about the shoulder, so speed grows with radius). Arm reach = shoulder pivot to hand end of this body at rest (printed below);
// weapon length = weapons.<id>.length_m in data/rules.json. The lever table at the end lists the resulting tip speeds per weapon row.
// A swing = one run of tip speed above --start m/s (runs closer than --gap s are joined); its value is the PEAK tip speed of the run. Speed is the
// backward difference of the tip position over --window ticks (default 3 = 0.05 s: V3 steps its clips at 20 fps, so a 1 or 2 tick difference shows
// stair-step spikes). A run whose speed was still under --snap (0.3) x its peak three ticks before the peak rose in under 0.05 s: that is a pose
// snap (a hit reaction or a state switch; the hands of both arms jump together), not a swing, and it is counted apart. The dump carries no clip labels, so swings are classed by how long the run lasts:
// light (short), heavy (long) from the run duration; "special" is not identifiable in this dump and is reported as unmeasured.
import { readFileSync, writeFileSync } from "node:fs";
import { loadTable, generateRow } from "../src/generate.mjs";
import { buildDefinition } from "../src/engine.mjs";
import { qmul, qconj, qrot, vadd, vsub } from "../src/math.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i < 0 ? d : args.splice(i, 2)[1]; };
const startV = Number(opt("start", 2.0)), gapS = Number(opt("gap", 0.15));
const win = Number(opt("window", 3)), snapRise = Number(opt("snap", 0.3)), jsonOut = opt("json", null), seriesOut = opt("series", null);
const [posesFile, bodyFile] = args;
if (!posesFile || !bodyFile) { console.error("usage: node tools/tip-speed.mjs <poses.json> <body.measure.json> [--start m/s] [--gap s]"); process.exit(1); }

const dump = JSON.parse(readFileSync(posesFile, "utf8")), body = JSON.parse(readFileSync(bodyFile, "utf8"));
const rules = JSON.parse(readFileSync(new URL("../data/rules.json", import.meta.url), "utf8"));

const row = generateRow(body.id, body, loadTable());
const D = buildDefinition(row), roles = row.roles, n = D.def.length;
if (JSON.stringify(roles.map((r) => r.id)) !== JSON.stringify(dump.partIds)) throw new Error("partIds differ from the dump");
const hz = dump.tickHz;

// part pivots and the hand end for one tick (same chain as snapToTarget)
function fk(f) {
  const at = (i) => f.target.slice(i * 4, i * 4 + 4);
  const delta = D.def.map((_, i) => qmul(at(i), qconj(roles[i].rest.quat)));
  const pivot = new Array(n);
  pivot[0] = vsub(f.root.slice(0, 3), qrot(delta[0], vsub(D.spawn[0].c, D.pivot[0])));
  for (let i = 1; i < n; i++) { const p = D.def[i].parent; pivot[i] = vadd(pivot[p], qrot(delta[p], vsub(D.pivot[i], D.pivot[p]))); }
  const tips = {};
  for (const side of ["Left", "Right"]) {
    const i = D.idx["hand" + side], len = 2 * (D.def[i].halfH + D.def[i].r), dir = qrot(delta[i], roles[i].rest.dir);
    const hand = vadd(pivot[i], dir.map((x) => x * len));
    tips[side] = { hand };
  }
  return tips;
}
const tips = dump.frames.map(fk);
const kind = "hand";
// arm reach at rest: shoulder (arm pivot) to hand end, per side, from the same rest chain
const reachOf = (side) => {
  const a = D.pivot[D.idx["arm" + side]], h = D.idx["hand" + side], len = 2 * (D.def[h].halfH + D.def[h].r);
  const end = vadd(D.pivot[h], roles[h].rest.dir.map((x) => x * len));
  return Math.hypot(end[0] - a[0], end[1] - a[1], end[2] - a[2]);
};
const armReach = { Left: reachOf("Left"), Right: reachOf("Right") };
armReach.mean = (armReach.Left + armReach.Right) / 2;
const quant = (a, f) => { const s = [...a].sort((x, y) => x - y); if (!s.length) return null; const k = (s.length - 1) * f, lo = Math.floor(k); return s[lo] + (s[Math.min(s.length - 1, lo + 1)] - s[lo]) * (k - lo); };
const r2 = (x) => (x === null ? "-" : x.toFixed(2));

const swings = [];
const series = { Left: [], Right: [] };
for (const side of ["Left", "Right"]) {
  const sp = tips.map((_, t) => {
    const t0 = Math.max(0, t - win), a = tips[t0][side][kind], b = tips[t][side][kind];
    return t === t0 ? 0 : Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / ((t - t0) / hz);
  });
  series[side] = sp;
  // runs above startV, joined across short gaps
  let runs = [], cur = null;
  sp.forEach((v, t) => {
    if (v >= startV) { if (cur && t - cur.end <= gapS * hz) cur.end = t; else { cur = { start: t, end: t }; runs.push(cur); } }
  });
  for (const r of runs) {
    let peak = 0, pk = r.start;
    for (let t = r.start; t <= r.end; t++) if (sp[t] > peak) { peak = sp[t]; pk = t; }
    const snap = sp[Math.max(0, pk - 3)] < snapRise * peak;
    swings.push({ snap, side, start_s: +(r.start / hz).toFixed(3), dur_s: +((r.end - r.start + 1) / hz).toFixed(3), peak_m_s: +peak.toFixed(3), peak_s: +(pk / hz).toFixed(3) });
  }
}
swings.sort((a, b) => a.start_s - b.start_s);
if (seriesOut) writeFileSync(seriesOut, "tick,left_m_s,right_m_s\n" + series.Left.map((v, t) => `${t},${v.toFixed(3)},${series.Right[t].toFixed(3)}`).join("\n") + "\n");

// class by duration: heavy = longer than the median run duration of all swings (the dump has no labels)
const all = [...swings], snaps = all.filter((s) => s.snap);
swings.splice(0, swings.length, ...all.filter((s) => !s.snap));
const durMedian = quant(swings.map((s) => s.dur_s), 0.5);
for (const s of swings) s.class = s.dur_s > durMedian ? "heavy" : "light";
const table = (rows) => {
  const v = rows.map((s) => s.peak_m_s);
  return { n: rows.length, p50: quant(v, 0.5), p90: quant(v, 0.9), p99: quant(v, 0.99), max: v.length ? Math.max(...v) : null };
};
const out = {
  dump: posesFile, body: body.id, ticks: dump.frames.length, tick_hz: hz, tip: "hand end (hand pivot + hand length along its axis)", arm_reach_m: armReach,
  start_m_s: startV, gap_s: gapS, duration_median_s: durMedian,
  window_ticks: win, snap_rise: snapRise, snaps_excluded: { n: snaps.length, peaks_m_s: snaps.map((s) => s.peak_m_s), note: "peak reached in under 3 ticks: pose snaps (hit reaction or state switch), not swings" },
  classes: { all: table(swings), light: table(swings.filter((s) => s.class === "light")), heavy: table(swings.filter((s) => s.class === "heavy")), special: { n: 0, note: "not identifiable: the dump has no clip labels" } },
  by_side: { Left: table(swings.filter((s) => s.side === "Left")), Right: table(swings.filter((s) => s.side === "Right")) },
  swings,
};
// tip speed per weapon row = hand speed x lever
out.levers = {};
for (const [id, w] of Object.entries(rules.weapons)) {
  if (typeof w.length_m !== "number") { out.levers[id] = { length_m: null, note: w.todo || "no length_m row" }; continue; }
  const lever = (armReach.mean + w.length_m) / armReach.mean;
  const scale = (t) => ({ n: t.n, p50: t.p50 * lever, p90: t.p90 * lever, p99: t.p99 * lever, max: t.max * lever });
  out.levers[id] = { length_m: w.length_m, lever, tip: { all: scale(out.classes.all), light: scale(out.classes.light), heavy: scale(out.classes.heavy) } };
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(out, null, 1) + "\n");
console.log(`tip: ${out.tip}; arm reach (shoulder to hand end, rest) left ${armReach.Left.toFixed(4)} right ${armReach.Right.toFixed(4)} mean ${armReach.mean.toFixed(4)} m\nticks ${out.ticks} at ${hz} Hz, run start ${startV} m/s, gap ${gapS} s, duration split at median ${durMedian} s, swings ${swings.length} (+ ${snaps.length} pose snaps excluded)`);
console.log("class".padEnd(10), "n".padStart(4), "p50".padStart(7), "p90".padStart(7), "p99".padStart(7), "max".padStart(7));
for (const [k, t] of [...Object.entries(out.classes), ...Object.entries(out.by_side).map(([k, t]) => ["side " + k, t])]) {
  if (t.note) { console.log(k.padEnd(10), "0".padStart(4), "unmeasured (" + t.note + ")"); continue; }
  console.log(k.padEnd(10), String(t.n).padStart(4), r2(t.p50).padStart(7), r2(t.p90).padStart(7), r2(t.p99).padStart(7), r2(t.max).padStart(7));
}
console.log("swings (side start_s dur_s peak_m_s class):");
for (const s of [...swings, ...snaps].sort((a, b) => a.start_s - b.start_s)) console.log(" ", s.side.padEnd(5), String(s.start_s).padStart(6), String(s.dur_s).padStart(6), s.peak_m_s.toFixed(2).padStart(6), s.snap ? "SNAP (excluded)" : s.class);
console.log("weapon tip speed = hand x lever, lever = (arm reach + length_m) / arm reach (id, lever | light p50 p90 p99 | heavy p50 p90 p99):");
for (const [id, l] of Object.entries(out.levers)) {
  if (l.length_m === null) { console.log(" ", id.padEnd(16), "no length_m (" + l.note + ")"); continue; }
  const f = (t) => [t.p50, t.p90, t.p99].map((v) => v.toFixed(1).padStart(6)).join("");
  console.log(" ", id.padEnd(16), l.lever.toFixed(3).padStart(6), "|", f(l.tip.light), "|", f(l.tip.heavy));
}
