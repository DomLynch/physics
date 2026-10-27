// M4 widened calibration sample (data/m4-swing-sample.json): pins what the sample is and what the rungs derived from it say, so a data PR that changes the
// sample, or a rung move, shows here first. Deterministic: reads committed numbers only, no GLB, no clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadRules } from "../src/rules.mjs";
import { deriveRungs, REPIN_TOLERANCE, FLOOR_M_S } from "../tools/swing-sample.mjs";

const rules = loadRules();
const sample = JSON.parse(readFileSync(new URL("../data/m4-swing-sample.json", import.meta.url), "utf8"));
const r2 = (x) => Math.round(x * 100) / 100;

test("sample: 12 fight-dump swings plus 106-rig clip swings, no snaps, no specials in the rung sample", () => {
  const by = (f) => sample.swings.filter(f);
  assert.equal(by((s) => s.source === "fight_dump").length, 12);
  assert.equal(by((s) => s.source === "clip_106" && s.body === "psyche-106" && s.class !== "special").length, 23);
  assert.equal(by((s) => s.source === "clip_106" && s.body === "minotaur-106" && s.class !== "special").length, 5);
  assert.equal(by((s) => s.class === "special").length, 9, "special swings are kept apart");
  assert.ok(sample.swings.every((s) => s.peak_m_s >= 2.0 && ["light", "heavy", "special"].includes(s.class)));
  // clip swings carry the V3 clip label; the dump has none
  assert.ok(by((s) => s.source === "clip_106").every((s) => typeof s.clip === "string"));
  assert.ok(by((s) => s.source === "fight_dump").every((s) => s.clip === null));
});

test("the fight-dump part of the sample is the 12-swing table the pins were derived from (p10 4.01, p50 8.27, p90 12.18)", () => {
  const d = deriveRungs({ swings: sample.swings.filter((s) => s.source === "fight_dump") }, rules);
  assert.deepEqual([d.hand.n, r2(d.hand.p10), r2(d.hand.p50), r2(d.hand.p90)], [12, 4.01, 8.27, 12.18]);
});

test("widened sample (40 swings): hand percentiles and the rungs they derive", () => {
  const d = deriveRungs(sample, rules);
  assert.deepEqual([d.hand.n, r2(d.hand.p10), r2(d.hand.p50), r2(d.hand.p90)], [40, 2.28, 6.05, 11.59]);
  assert.equal(r2(d.base_lever), 1.99);
  // the cut rung (p90) is within the re-pin tolerance of its pin: not moved
  assert.ok(!d.rungs.rung_cut.beyond_tolerance, `cut ${d.rungs.rung_cut.derived} vs pin ${d.rungs.rung_cut.pin}`);
  assert.equal(r2(d.rungs.rung_cut.derived), 23.08);
  // hit and stick fall beyond it on the identical method; the pins stay (docs/M4-CALIBRATION.md section 6 says why), so this row says so when the sample or a pin changes
  assert.ok(d.rungs.rung_hit.beyond_tolerance && d.rungs.rung_stick.beyond_tolerance);
  assert.deepEqual([rules.strength_scale.rung_hit, rules.strength_scale.rung_stick, rules.strength_scale.rung_cut], [8.0, 16.5, 24.3]);
});

test("sensitivity: leaving out clip-edge fragments (peaks under 3 m/s) puts hit and cut within tolerance, stick 12 percent under its pin", () => {
  const d = deriveRungs(sample, rules, { floor: FLOOR_M_S });
  assert.deepEqual([d.hand.n, r2(d.hand.p10), r2(d.hand.p50), r2(d.hand.p90)], [30, 3.85, 7.28, 11.63]);
  assert.ok(!d.rungs.rung_hit.beyond_tolerance && !d.rungs.rung_cut.beyond_tolerance);
  assert.ok(d.rungs.rung_stick.beyond_tolerance && Math.abs(d.rungs.rung_stick.rel + 0.121) < 0.001);
  assert.equal(REPIN_TOLERANCE, 0.1);
});

test("labelled clips do not support heavy_mult 1.92: heavy clips are not faster than light ones (the charge is a game mechanic, not a clip speed)", () => {
  // clip_106 only: the dump's classes are a duration proxy, not labels
  const d = deriveRungs({ swings: sample.swings.filter((s) => s.source === "clip_106") }, rules);
  assert.deepEqual([d.classes.heavy.n, d.classes.light.n], [7, 21]);
  assert.ok(d.heavy_over_light_p50 > 1.03 && d.heavy_over_light_p50 < 1.07, String(d.heavy_over_light_p50));
  assert.equal(rules.swing.heavy_mult, 1.92);
});
