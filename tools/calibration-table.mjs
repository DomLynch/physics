// M4 calibration behaviour table, computed by running the evaluator (nothing is typed in): for each swing type x armour tier, the outcome of
// one slash on a bare arm (zone arm_off, a severable unit) for the baseline blade and for the strongest weapon in the rows.
//   node tools/calibration-table.mjs            prints markdown (this is what docs/M4-CALIBRATION.md embeds)
//   import { buildCalibration } from "./calibration-table.mjs"   (test/calibration.test.mjs asserts the key rows)
// Hand speeds come from the rows (swing.hand_speed_ref_m_s: measured light p50 / p90 of the V3 Minotaur dump); the evaluator turns them into tip
// speed with the weapon's lever, then applies sharpness, heavy_mult and counter_hit_mult. Outcome words: miss, hit, stick, cut (a cut is a
// severed arm; stab and blunt never cut, see docs/API.md). The ratio in each cell is strength / the cut threshold of that tier.
import { fileURLToPath } from "node:url";
import { loadRules } from "../src/rules.mjs";
import { createEvaluator, createFighterState } from "../src/rules-eval.mjs";

const TIERS = ["none", "cloth", "leather", "mail", "plate_t2", "plate_t3"];

export function swingRows(rules) {
  const ref = rules.swing.hand_speed_ref_m_s;
  return [
    { id: "light_typical", label: "light, typical (p50 hand)", hand: ref.light_p50, swing: "light", counterHit: false },
    { id: "light", label: "light, full speed (p90 hand)", hand: ref.light_p90, swing: "light", counterHit: false },
    { id: "light_counter", label: "light + counter-hit", hand: ref.light_p90, swing: "light", counterHit: true },
    { id: "heavy", label: "heavy", hand: ref.light_p90, swing: "heavy", counterHit: false },
    { id: "heavy_counter", label: "heavy + counter-hit", hand: ref.light_p90, swing: "heavy", counterHit: true },
  ];
}

// the weapon with the most slash strength on the same swing: lever x slash sharpness (only weapons with a length and a slash row)
export function strongestWeapon(rules, armReach = rules.lever.arm_reach_m) {
  let best = null;
  for (const [id, w] of Object.entries(rules.weapons)) {
    if (typeof w.length_m !== "number" || typeof w.slash_sharpness !== "number") continue;
    const power = ((armReach + w.length_m) / armReach) * w.slash_sharpness;
    if (!best || power > best.power) best = { id, power };
  }
  return best.id;
}

export function buildCalibration(rules = loadRules()) {
  const ev = createEvaluator(rules);
  const S = rules.strength_scale;
  const baseline = S.baseline_weapon;
  const strongest = strongestWeapon(rules);
  let t = 0;
  const cell = (weaponId, row, tier) => {
    const st = createFighterState(rules);
    const r = ev.evaluateHit({ weapon: weaponId, kind: "slash", zone: "arm_off", armour: tier, handSpeed: row.hand, swing: row.swing, counterHit: row.counterHit, t: (t += 100) }, st);
    const outcome = r.cut ? "cut" : r.strength >= S.rung_stick ? "stick" : r.strength >= S.rung_hit ? "hit" : "miss";
    return { outcome, strength: r.strength, tipSpeed: r.tipSpeed, lever: r.lever, cutThreshold: r.cutThreshold, ratio: r.strength / r.cutThreshold };
  };
  const table = {};
  for (const w of [baseline, strongest]) {
    table[w] = {};
    for (const row of swingRows(rules)) {
      table[w][row.id] = {};
      for (const tier of TIERS) table[w][row.id][tier] = cell(w, row, tier);
    }
  }
  // the reachability check: the strongest allowed hit against the top threshold
  const refHand = rules.swing.hand_speed_ref_m_s.light_p90;
  const lever = (id) => (rules.lever.arm_reach_m + rules.weapons[id].length_m) / rules.lever.arm_reach_m;
  const maxMod = Math.max(...Object.values(rules.armour_tiers).map((x) => x.dismember_threshold_modifier));
  const topThreshold = S.rung_cut * maxMod;
  const bestSlashRatio = Math.max(...Object.values(rules.weapons).map((w) => (typeof w.slash_sharpness === "number" ? w.slash_sharpness : 0)));
  const bestStabRatio = Math.max(...Object.values(rules.weapons).map((w) => (typeof w.stab_sharpness === "number" ? w.stab_sharpness : 0)));
  const mult = rules.swing.heavy_mult * rules.swing.counter_hit_mult;
  const baseTip = refHand * lever(baseline);
  const reach = {
    top_threshold: topThreshold,
    baseline_tip: baseTip,
    strongest_ratio_only: baseTip * mult * bestSlashRatio,
    strongest_with_lever: refHand * lever(strongest) * rules.weapons[strongest].slash_sharpness * mult,
    best_slash_ratio: bestSlashRatio,
    best_stab_ratio: bestStabRatio,
  };
  return { baseline, strongest, table, reach, tiers: TIERS, rows: swingRows(rules) };
}

function markdown(c, rules) {
  const f = (n, d = 1) => n.toFixed(d);
  const out = [];
  out.push(`Rungs (tip speed m/s of strength at sharpness 1.0): hit ${rules.strength_scale.rung_hit}, stick ${rules.strength_scale.rung_stick}, cut ${rules.strength_scale.rung_cut}. heavy_mult ${rules.swing.heavy_mult}, counter_hit_mult ${rules.swing.counter_hit_mult}, arm reach ${rules.lever.arm_reach_m} m.`);
  out.push(`Cut threshold per tier: ${TIERS.map((x) => `${x} ${f(rules.strength_scale.rung_cut * rules.armour_tiers[x].dismember_threshold_modifier)}`).join(", ")}.`);
  for (const w of [c.baseline, c.strongest]) {
    const l = (rules.lever.arm_reach_m + rules.weapons[w].length_m) / rules.lever.arm_reach_m;
    out.push("", `**${w === c.baseline ? "Baseline blade" : "Strongest weapon"}: ${w}** (length ${rules.weapons[w].length_m} m, lever ${f(l, 3)}, slash sharpness ${rules.weapons[w].slash_sharpness})`, "");
    out.push(`| swing (hand m/s) | tip m/s | ${TIERS.join(" | ")} |`, `|---|---|${TIERS.map(() => "---").join("|")}|`);
    for (const row of c.rows) {
      const cells = TIERS.map((tier) => { const x = c.table[w][row.id][tier]; return `${x.outcome} (${f(x.ratio, 2)})`; });
      out.push(`| ${row.label} (${row.hand}) | ${f(c.table[w][row.id].none.tipSpeed)} | ${cells.join(" | ")} |`);
    }
  }
  const r = c.reach;
  out.push("", `Reachability: top threshold ${f(r.top_threshold, 2)}. Baseline blade full-speed light tip ${f(r.baseline_tip, 2)} x heavy ${rules.swing.heavy_mult} x counter-hit ${rules.swing.counter_hit_mult} x best slash ratio ${r.best_slash_ratio} = ${f(r.strongest_ratio_only, 2)} (${r.strongest_ratio_only > r.top_threshold ? "exceeds" : "DOES NOT exceed"} the top threshold). Strongest weapon (${c.strongest}) with its lever: ${f(r.strongest_with_lever, 2)}. Best stab ratio ${r.best_stab_ratio} (stabs never sever).`);
  return out.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rules = loadRules();
  console.log(markdown(buildCalibration(rules), rules));
}
