// Phone bench page: the M3 proof scene (five active ragdolls, one cut at tick 60, 240 ticks) timed per frame in the PAGE with performance.now.
// src/ never reads a clock; the timing lives here only. Built into one file by build.mjs.
import { createPhysics } from "../../src/index.mjs";
import minotaur from "../../data/bodies/minotaur.measure.json";

const BUDGET_MS = 3, TICKS = 240, CUT_TICK = 60, WARM = 30, REF_CAL_MS = 20.2;
const $ = (id) => document.getElementById(id);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

// 4M-iteration float loop, median of 5 (same shape as OpenTrident m3-core calibrate)
function calibrate() {
  const times = []; let sink = 0;
  for (let k = 0; k < 5; k++) {
    const t0 = performance.now(); let acc = 0.123;
    for (let i = 1; i < 4_000_000; i++) acc = acc * 0.999999 + Math.sin(i * 0.001) * Math.sqrt(i) * 1e-6;
    sink += acc; times.push(performance.now() - t0);
  }
  return { ms: median(times), sink };
}

async function scene() {
  const physics = await createPhysics({ seed: 1 });
  const rds = [0, 1, 2, 3, 4].map((k) => physics.createRagdoll(minotaur, { position: [(k - 2) * 0.9, 0, 0], id: "f" + k }));
  const times = [];
  for (let t = 0; t < TICKS; t++) {
    if (t === CUT_TICK) rds[0].cut("arm_right");
    const t0 = performance.now();
    for (const r of rds) r.setMotorStrength({ all: t % 120 < 60 ? 1 : 0.8 });
    physics.step(1 / 60);
    for (const r of rds) r.readPose();
    const dt = performance.now() - t0;
    if (t >= WARM) times.push(dt);
  }
  const hash = physics.hash();
  physics.destroy();
  return { times, hash };
}

const fmt = (v) => v.toFixed(2);
let running = false;
async function run() {
  if (running) return; running = true;
  const btn = $("again"); btn.disabled = true;
  $("verdict").className = ""; $("verdict").textContent = "running..."; $("st").textContent = "calibrating";
  window.__result = null;
  await new Promise((r) => setTimeout(r, 30)); // let the label paint before the busy loops
  try {
    const cal = calibrate();
    $("cal").textContent = fmt(cal.ms) + " ms (" + (cal.ms / REF_CAL_MS).toFixed(2) + "x the quiet Mac)";
    $("st").textContent = "simulating";
    await new Promise((r) => setTimeout(r, 30));
    const { times, hash } = await scene();
    const s = [...times].sort((a, b) => a - b);
    const avg = times.reduce((a, b) => a + b, 0) / times.length, p95 = s[Math.floor(s.length * 0.95)], max = s[s.length - 1];
    const under = avg < BUDGET_MS && p95 < BUDGET_MS;
    $("avg").textContent = fmt(avg); $("p95").textContent = fmt(p95); $("max").textContent = fmt(max);
    $("verdict").textContent = (under ? "UNDER " : "OVER ") + BUDGET_MS + " ms"; $("verdict").className = under ? "ok" : "bad";
    $("st").textContent = "done, " + times.length + " frames timed (first " + WARM + " of " + TICKS + " ticks are warm-up)";
    window.__result = { ok: true, verdict: under ? "UNDER" : "OVER", budget_ms: BUDGET_MS, avg_ms: +avg.toFixed(3), p95_ms: +p95.toFixed(3), max_ms: +max.toFixed(3),
      frames: times.length, ticks: TICKS, warmup_ticks: WARM, cut_tick: CUT_TICK, fighters: 5, calibration_ms: +cal.ms.toFixed(2), calibration_ref_ms: REF_CAL_MS,
      hash, sha: __GIT_SHA__, ua: navigator.userAgent };
  } catch (e) {
    $("verdict").textContent = "ERROR"; $("verdict").className = "bad"; $("st").textContent = String((e && e.stack) || e).slice(0, 400);
    window.__result = { ok: false, error: String((e && e.stack) || e), sha: __GIT_SHA__, ua: navigator.userAgent };
  }
  btn.disabled = false; running = false;
}

$("sha").textContent = __GIT_SHA__; $("ua").textContent = navigator.userAgent;
$("again").addEventListener("click", run);
window.__run = run;
run();
