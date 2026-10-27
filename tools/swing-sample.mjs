// M4 widened calibration sample: merges the 12-swing fight-dump table (tools/tip-speed.mjs --json) with the 106-rig clip swings (tools/clip-swings.mjs) into
// data/m4-swing-sample.json (numbers and clip names only, no body source), and derives the rung percentiles the way docs/M4-CALIBRATION.md section 3 does.
//   node tools/swing-sample.mjs <dump.json> <psyche-clips.json> <minotaur-clips.json> [--out data/m4-swing-sample.json]
//   node tools/swing-sample.mjs                       prints the derivation from the committed data/m4-swing-sample.json
// deriveRungs() is pure (the test imports it): hand-speed percentiles p10 / p50 / p90 of the non-special swing peaks, times the baseline lever, against the pins.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SAMPLE_URL = new URL("../data/m4-swing-sample.json", import.meta.url);
// a rung is re-pinned only when the wider sample moves it by more than this (relative); inside it the pin stays and the number is only reported
export const REPIN_TOLERANCE = 0.10;
// hand speed under this is not a swing for the sensitivity row: the clips' edge fragments (a run of 2 to 3 m/s at the start or end of a clip)
export const FLOOR_M_S = 3.0;

export const quant = (a, f) => {
  const s = [...a].sort((x, y) => x - y);
  if (!s.length) return null;
  const k = (s.length - 1) * f, lo = Math.floor(k);
  return s[lo] + (s[Math.min(s.length - 1, lo + 1)] - s[lo]) * (k - lo);
};

export function buildSample(dump, clipSets) {
  const swings = [];
  for (const s of dump.swings.filter((x) => !x.snap)) swings.push({ source: "fight_dump", body: dump.body, clip: null, class: s.class, side: s.side, peak_m_s: s.peak_m_s });
  for (const c of clipSets) for (const s of c.swings.filter((x) => !x.snap)) swings.push({ source: "clip_106", body: c.body, clip: s.clip, class: s.class, side: s.side, peak_m_s: s.peak_m_s });
  return {
    schema: "m4-swing-sample/1",
    about: "Hand-end speed peaks (m/s) of the swings behind the M4 rungs. fight_dump = V3 recorded Minotaur fight on the 65 rig (12 swings, class by run duration, a proxy); clip_106 = the Mixamo melee clips baked in the 106-rig body GLBs, class from the clip label (Attack, Riposte, Cut_Outward(+Mirror), Stab = light; Heavy, Heavy_Gladius = heavy; Skill_* = special, kept apart). Same run detector for both (tools/tip-speed.mjs and tools/clip-swings.mjs: start 2.0 m/s, gap 0.15 s, 3-tick window, pose snaps excluded).",
    arm_reach_m: { fight_dump: dump.arm_reach_m.mean, ...Object.fromEntries(clipSets.map((c) => [c.body, c.arm_reach_m.mean])) },
    swings,
  };
}

export function deriveRungs(sample, rules, { floor = 0 } = {}) {
  const S = rules.strength_scale, baseLever = (rules.lever.arm_reach_m + rules.weapons[S.baseline_weapon].length_m) / rules.lever.arm_reach_m;
  const v = (f) => sample.swings.filter((s) => s.class !== "special" && s.peak_m_s >= floor && f(s)).map((s) => s.peak_m_s);
  const all = v(() => true);
  const hand = { n: all.length, p10: quant(all, 0.1), p50: quant(all, 0.5), p90: quant(all, 0.9) };
  const pins = { rung_hit: S.rung_hit, rung_stick: S.rung_stick, rung_cut: S.rung_cut };
  const derived = { rung_hit: hand.p10 * baseLever, rung_stick: hand.p50 * baseLever, rung_cut: hand.p90 * baseLever };
  const rungs = {};
  for (const k of Object.keys(pins)) rungs[k] = { pin: pins[k], derived: derived[k], rel: derived[k] / pins[k] - 1, beyond_tolerance: Math.abs(derived[k] / pins[k] - 1) > REPIN_TOLERANCE };
  const light = v((s) => s.class === "light"), heavy = v((s) => s.class === "heavy");
  return {
    base_lever: baseLever, hand, rungs,
    classes: { light: { n: light.length, p50: quant(light, 0.5), p90: quant(light, 0.9) }, heavy: { n: heavy.length, p50: quant(heavy, 0.5), p90: quant(heavy, 0.9) } },
    heavy_over_light_p50: quant(heavy, 0.5) / quant(light, 0.5),
  };
}

function print(sample, rules) {
  const f = (x, d = 2) => (x === null ? "-" : x.toFixed(d));
  for (const [name, opt] of [["identical method (no floor)", {}], [`sensitivity: peaks >= ${FLOOR_M_S} m/s`, { floor: FLOOR_M_S }]]) {
    const d = deriveRungs(sample, rules, opt);
    console.log(`${name}: ${d.hand.n} swings, hand p10 ${f(d.hand.p10)} p50 ${f(d.hand.p50)} p90 ${f(d.hand.p90)}, baseline lever ${f(d.base_lever, 3)}`);
    for (const [k, r] of Object.entries(d.rungs)) console.log(`  ${k.padEnd(11)} pin ${f(r.pin, 1)}  derived ${f(r.derived, 1)}  ${(r.rel * 100).toFixed(1).padStart(6)}%  ${r.beyond_tolerance ? "BEYOND" : "within"} ${REPIN_TOLERANCE * 100}%`);
    console.log(`  light n ${d.classes.light.n} p50 ${f(d.classes.light.p50)} p90 ${f(d.classes.light.p90)}; heavy n ${d.classes.heavy.n} p50 ${f(d.classes.heavy.p50)} p90 ${f(d.classes.heavy.p90)}; heavy/light p50 ${f(d.heavy_over_light_p50)} (heavy_mult pin ${rules.swing.heavy_mult})`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), oi = args.indexOf("--out"), out = oi < 0 ? null : args.splice(oi, 2)[1];
  const rules = JSON.parse(readFileSync(new URL("../data/rules.json", import.meta.url), "utf8"));
  let sample;
  if (args.length >= 2) {
    const [dumpF, ...clipFs] = args;
    sample = buildSample(JSON.parse(readFileSync(dumpF, "utf8")), clipFs.map((p) => JSON.parse(readFileSync(p, "utf8"))));
    writeFileSync(out || fileURLToPath(SAMPLE_URL), JSON.stringify(sample, null, 1) + "\n");
  } else sample = JSON.parse(readFileSync(SAMPLE_URL, "utf8"));
  print(sample, rules);
}
