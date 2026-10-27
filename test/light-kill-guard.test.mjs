// Strength-rung bug (Dom: "one light hit, the Minotaur falls, often"): under M4 a LIGHT counter-hit (strength 28.7 to 32.4 on a longsword =
// the katana row) is over the cut rung (24.3), and a cut removes the part's whole budget, so it evaluated `kill` on a bare, undamaged
// Minotaur's head or torso. Rule row evaluator.kill.light_floor_pct: a light swing never takes an undamaged kill part (head, torso) to zero.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEvaluator, createFighterState, loadRules } from "../src/index.mjs";

const rules = loadRules();
const ev = createEvaluator(rules);
// the Minotaur as V3 builds it: hp_scale = 190 / 150 (his sim health over a man's), head budget 40
const minotaur = (r = rules) => createFighterState(r, undefined, { hp_scale: 190 / 150, budgets: { head: 40 } });
let clock = 0;
const hit = (o) => ({ weapon: "gm_katana", kind: "slash", zone: "torso", armour: "none", t: (clock += 100), ...o });
const SPEEDS = [6.25, 7, 8, 9, 9.74, 11, 12.2, 13]; // hand m/s: the package's light p50, p90 and beyond
const floorPct = () => rules.evaluator.kill.light_floor_pct;

test("repro: a light counter-hit with a longsword (katana row) never evaluates kill on an undamaged Minotaur", () => {
  let sawStrength = 0, sawOverCut = false;
  for (const zone of ["head", "torso"]) for (const handSpeed of SPEEDS) {
    const r = ev.evaluateHit(hit({ zone, handSpeed, swing: "light", counterHit: true }), minotaur());
    sawStrength = Math.max(sawStrength, r.strength); sawOverCut ||= r.strength >= rules.strength_scale.rung_cut;
    assert.notEqual(r.outcome, "kill", `${zone} @ ${handSpeed} m/s strength ${r.strength.toFixed(1)}: ${JSON.stringify(r.events)}`);
    assert.equal(r.state.alive, true);
    assert.equal(r.cut, null, `${zone} @ ${handSpeed}: a light blow does not sever an undamaged head or torso`);
  }
  assert.ok(sawOverCut && sawStrength > 28, "the sweep really reaches the strengths Dom saw (over the cut rung)");
});

test("a light swing on an undamaged kill part leaves it above zero, whatever the strength", () => {
  for (const zone of ["head", "torso"]) {
    const st = minotaur();
    const r = ev.evaluateHit(hit({ zone, tipSpeed: 200, swing: "light", counterHit: true }), st);
    assert.ok(st.parts[zone].hp > 0 && !st.parts[zone].gone, `${zone} survives`);
    assert.ok(Math.abs(st.parts[zone].hp - st.parts[zone].max * floorPct() / 100) < 1e-9, "left at exactly the floor");
    assert.equal(r.state.alive, true);
  }
});

test("a heavy blow on an undamaged Minotaur still kills (the guard is for light swings only)", () => {
  const r = ev.evaluateHit(hit({ zone: "head", handSpeed: 9.74, swing: "heavy", counterHit: true }), minotaur());
  assert.equal(r.outcome, "kill");
});

test("a heavy blow on a damaged Minotaur still kills, and a light one does not once the part is at the floor", () => {
  const st = minotaur();
  let n = 0;
  while (st.parts.torso.hp > st.parts.torso.max * floorPct() / 100 && n++ < 100) {
    const r = ev.evaluateHit(hit({ zone: "torso", handSpeed: 9.74, swing: "light" }), st);
    assert.notEqual(r.outcome, "kill", "light blows do not kill while the part is above the floor");
  }
  assert.ok(st.parts.torso.hp > 0 && st.alive, "worn down, alive");
  const heavy = ev.evaluateHit(hit({ zone: "torso", handSpeed: 9.74, swing: "heavy" }), JSON.parse(JSON.stringify(st)));
  assert.equal(heavy.outcome, "kill", "heavy on the damaged part");
  // changed from #49 (which asserted a light counter-hit at the floor kills = the 2-hit kill): at the floor a light blow no longer finishes it (heavy_kill_floor_pct)
  const light = ev.evaluateHit(hit({ zone: "torso", handSpeed: 9.74, swing: "light", counterHit: true }), st);
  assert.notEqual(light.outcome, "kill", "light counter-hit on a part at the floor does not finish it");
});

test("the guard is a row: 0 turns it off (the old behaviour), and a missing row throws", () => {
  const off = JSON.parse(JSON.stringify(rules)); off.evaluator.kill.light_floor_pct = 0;
  const r = createEvaluator(off).evaluateHit(hit({ zone: "head", handSpeed: 9.74, swing: "light", counterHit: true }), minotaur(off));
  assert.equal(r.outcome, "kill", "the pre-fix result, from the row alone");
  const bare = JSON.parse(JSON.stringify(rules)); delete bare.evaluator.kill.light_floor_pct;
  assert.throws(() => createEvaluator(bare));
});

test("limbs still cut on a light counter-hit (the guard is for the kill parts only)", () => {
  const r = ev.evaluateHit(hit({ zone: "arm_off", handSpeed: 9.74, swing: "light", counterHit: true }), minotaur());
  assert.equal(r.outcome, "cut");
});

// Follow-up (reviewer gap on #49): the light floor only DEFERRED the kill, because the second light counter-hit saw hp <= floor and killed.
// Row evaluator.kill.heavy_kill_floor_pct: a LIGHT swing never takes a kill part to zero (no cut, damage stops at the floor) while the part's
// hp is AT OR ABOVE this percent of its budget; only a heavy blow finishes it. A light swing on a part already strictly under the floor may still finish it.
const heavyFloorPct = () => rules.evaluator.kill.heavy_kill_floor_pct;

test("heavy_kill_floor_pct: any number of light counter-hits and light swings never kill a full Minotaur, then a heavy blow does", () => {
  assert.ok(heavyFloorPct() > 0, "the row exists and is on");
  for (const zone of ["head", "torso"]) {
    const st = minotaur();
    for (let i = 0; i < 60; i++) {
      const r = ev.evaluateHit(hit({ zone, handSpeed: SPEEDS[i % SPEEDS.length], swing: "light", counterHit: i % 2 === 0 }), st);
      assert.notEqual(r.outcome, "kill", `${zone} light hit #${i + 1}: ${JSON.stringify(r.events)}`);
      assert.equal(r.cut, null);
      assert.equal(st.alive, true);
      assert.ok(st.parts[zone].hp >= st.parts[zone].max * heavyFloorPct() / 100 - 1e-9, `${zone} stays at or above the floor`);
    }
    const heavy = ev.evaluateHit(hit({ zone, handSpeed: 9.74, swing: "heavy" }), st);
    assert.equal(heavy.outcome, "kill", `${zone}: a heavy blow finishes the chipped part`);
  }
});

test("heavy_kill_floor_pct: two light counter-hits in a row on a full Minotaur do not kill (the reviewer's repro)", () => {
  const st = minotaur();
  const a = ev.evaluateHit(hit({ zone: "head", handSpeed: 9.74, swing: "light", counterHit: true }), st);
  const b = ev.evaluateHit(hit({ zone: "head", handSpeed: 9.74, swing: "light", counterHit: true }), st);
  assert.notEqual(a.outcome, "kill"); assert.notEqual(b.outcome, "kill", JSON.stringify(b.events));
  assert.equal(st.alive, true);
});

test("heavy_kill_floor_pct: a light swing on a part strictly under the floor may still finish it; the row is a row (0 = off)", () => {
  const st = minotaur();
  st.parts.torso.hp = st.parts.torso.max * heavyFloorPct() / 100 * 0.5;
  assert.equal(ev.evaluateHit(hit({ zone: "torso", handSpeed: 9.74, swing: "light" }), st).outcome, "kill");
  const off = JSON.parse(JSON.stringify(rules)); off.evaluator.kill.heavy_kill_floor_pct = 0;
  const s2 = minotaur(off); const e2 = createEvaluator(off);
  e2.evaluateHit(hit({ zone: "head", handSpeed: 9.74, swing: "light", counterHit: true }), s2);
  assert.equal(e2.evaluateHit(hit({ zone: "head", handSpeed: 9.74, swing: "light", counterHit: true }), s2).outcome, "kill", "0 = the #49 behaviour");
  const bare = JSON.parse(JSON.stringify(rules)); delete bare.evaluator.kill.heavy_kill_floor_pct;
  assert.throws(() => createEvaluator(bare));
});
