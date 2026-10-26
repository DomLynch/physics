// M4 calibration: the behaviour table of docs/M4-CALIBRATION.md, computed by the evaluator from the rows (tools/calibration-table.mjs).
// If a measurement PR moves a rung or a multiplier so that one of these rows flips, this test says which design target broke.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRules } from "../src/rules.mjs";
import { buildCalibration } from "../tools/calibration-table.mjs";

const rules = loadRules();
const c = buildCalibration(rules);
const base = c.table[c.baseline];
const outcome = (row, tier, w = base) => w[row][tier].outcome;
const CUTTABLE_ON_BASE = ["none", "cloth", "leather", "mail", "plate_t2", "plate_t3"];

test("baseline blade: a normal full-speed light swing lands between stick and cut on cloth", () => {
  assert.equal(c.baseline, rules.strength_scale.baseline_weapon);
  assert.equal(outcome("light", "none"), "stick");
  assert.equal(outcome("light", "cloth"), "stick");
  assert.ok(base.light.cloth.strength >= rules.strength_scale.rung_stick && base.light.cloth.strength < base.light.cloth.cutThreshold);
  // a typical light swing is a hit, not a stick
  assert.equal(outcome("light_typical", "cloth"), "hit");
});

test("baseline blade: a heavy cuts cloth, leather and mail; a light does not cut mail", () => {
  for (const tier of ["none", "cloth", "leather", "mail"]) assert.equal(outcome("heavy", tier), "cut", "heavy on " + tier);
  assert.notEqual(outcome("light", "mail"), "cut");
  assert.notEqual(outcome("light_counter", "mail"), "cut", "a counter-hit alone does not cut mail");
  // only a heavy or a counter-hit cuts at all
  for (const tier of CUTTABLE_ON_BASE) assert.notEqual(outcome("light", tier), "cut", "light on " + tier);
  for (const tier of ["none", "cloth", "leather"]) assert.equal(outcome("light_counter", tier), "cut");
});

test("baseline blade: plate (tier 2 and top) needs a heavy AND a counter-hit", () => {
  for (const tier of ["plate_t2", "plate_t3"]) {
    for (const row of ["light", "light_counter", "heavy"]) assert.notEqual(outcome(row, tier), "cut", `${row} on ${tier}`);
    assert.equal(outcome("heavy_counter", tier), "cut", "heavy + counter-hit on " + tier);
  }
});

test("armour never blocks: no tier is unreachable for the strongest allowed hit (heavy x counter-hit x best weapon ratio beats the top threshold)", () => {
  const r = c.reach;
  assert.ok(r.top_threshold === rules.strength_scale.rung_cut * Math.max(...Object.values(rules.armour_tiers).map((t) => t.dismember_threshold_modifier)));
  assert.ok(r.strongest_ratio_only > r.top_threshold, `${r.strongest_ratio_only} must exceed ${r.top_threshold}`);
  assert.ok(r.strongest_with_lever > r.top_threshold);
  // and the evaluator agrees for every tier, for the baseline blade and for the strongest weapon
  for (const w of [c.baseline, c.strongest]) for (const tier of c.tiers) assert.equal(outcome("heavy_counter", tier, c.table[w]), "cut", `${w} on ${tier}`);
  // a heavier-than-allowed hit is not needed: no row of the table asks for more than heavy x counter-hit
  assert.ok(rules.swing.heavy_mult * rules.swing.counter_hit_mult * base.light.none.tipSpeed > r.top_threshold);
});

test("the strongest weapon is a different, longer weapon with a higher lever, and its table is monotonic in swing strength", () => {
  assert.notEqual(c.strongest, c.baseline);
  const order = ["light_typical", "light", "heavy", "heavy_counter"];
  const rank = { miss: 0, hit: 1, stick: 2, cut: 3 };
  for (const w of [c.baseline, c.strongest]) {
    for (const tier of c.tiers) {
      for (let i = 1; i < order.length; i++) assert.ok(rank[outcome(order[i], tier, c.table[w])] >= rank[outcome(order[i - 1], tier, c.table[w])], `${w} ${tier} ${order[i]}`);
    }
    for (const row of order) for (let i = 1; i < c.tiers.length; i++) assert.ok(rank[outcome(row, c.tiers[i], c.table[w])] <= rank[outcome(row, c.tiers[i - 1], c.table[w])], `${w} ${row} tier ${c.tiers[i]}`);
  }
});
