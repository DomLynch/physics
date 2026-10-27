// Strategy+Dom 2026-10-27: damage is CUMULATIVE. Zero health is dead, light or heavy. No floor (evaluator.kill.light_floor_pct and
// heavy_kill_floor_pct are gone). The only guarantee kept is the original strength-rung bug: a LIGHT swing never instantly CUTS or kills a
// HEALTHY head/torso in one blow. The cause is light counter-hit damage being too high, so it is tuned as a data row
// (evaluator.kill.light_damage_mult). Replaces test/light-kill-guard.test.mjs (which encoded the floors).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEvaluator, createFighterState, loadRules } from "../src/index.mjs";

const rules = loadRules();
const ev = createEvaluator(rules);
// the Minotaur as V3 builds it: hp_scale = 190 / 150, head budget 40 (torso 60 x 1.2667 = 76)
const minotaur = () => createFighterState(rules, undefined, { hp_scale: 190 / 150, budgets: { head: 40 } });
const man = () => createFighterState(rules);
let clock = 0;
const hit = (o) => ({ weapon: "gm_katana", kind: "slash", zone: "torso", armour: "none", t: (clock += 100), ...o });
const SPEEDS = [6.25, 7, 8, 9, 9.74, 11, 12.2, 13]; // hand m/s: the package's light p50, p90 and beyond
const HEAVY_P50 = rules.swing.hand_speed_ref_m_s.heavy_p50;
const mixedLight = (zone, i) => hit({ zone, handSpeed: SPEEDS[i % SPEEDS.length], swing: "light", counterHit: i % 2 === 0 });

function lightsToKill(zone, mk = minotaur) {
  const st = mk();
  for (let i = 0; i < 60; i++) {
    const r = ev.evaluateHit(mixedLight(zone, i), st);
    if (r.outcome === "kill") return { n: i + 1, r, st };
  }
  return { n: Infinity, st };
}

test("(1) 60 mixed light hits and counter-hits kill a fresh Minotaur torso by plain damage; it takes 6 to 10 of them", () => {
  const { n, r, st } = lightsToKill("torso");
  assert.ok(Number.isFinite(n), "the torso dies: damage is cumulative, no floor");
  assert.ok(n >= 6 && n <= 10, `lights to kill a fresh torso: ${n}`);
  assert.equal(st.alive, false);
  assert.equal(r.cut, null, "killed by damage, not by a cut");
  assert.equal(st.parts.torso.hp, 0);
});

test("(1b) the same for the head, and the floor events no longer exist", () => {
  const { n, st } = lightsToKill("head");
  assert.ok(Number.isFinite(n) && n >= 2, `head dies by damage after ${n} lights`);
  assert.equal(st.alive, false);
  const st2 = minotaur();
  for (let i = 0; i < 60; i++) {
    const r = ev.evaluateHit(mixedLight("torso", i), st2);
    assert.ok(!r.events.some((e) => e.type === "light_floor" || e.type === "heavy_kill_floor"), "no floor events");
    if (r.outcome === "kill") break;
  }
  assert.equal(rules.evaluator.kill.light_floor_pct, undefined, "floor row gone from the shipped rows");
  assert.equal(rules.evaluator.kill.heavy_kill_floor_pct, undefined, "floor row gone from the shipped rows");
});

test("(2) two heavy swings (heavy p50 hand speed) kill a fresh Minotaur torso; one does not; one kills a head", () => {
  const st = minotaur();
  const a = ev.evaluateHit(hit({ zone: "torso", handSpeed: HEAVY_P50, swing: "heavy" }), st);
  assert.notEqual(a.outcome, "kill");
  const b = ev.evaluateHit(hit({ zone: "torso", handSpeed: HEAVY_P50, swing: "heavy" }), st);
  assert.equal(b.outcome, "kill", JSON.stringify(b.events));
  const h = ev.evaluateHit(hit({ zone: "head", handSpeed: HEAVY_P50, swing: "heavy" }), minotaur());
  assert.equal(h.outcome, "kill");
});

test("(2b) heavy damage is UNCHANGED: strength x zone x global, no light multiplier", () => {
  for (const zone of ["head", "torso"]) {
    const st = minotaur();
    const r = ev.evaluateHit(hit({ zone, handSpeed: 9.74, swing: "heavy" }), st);
    const want = r.strength * rules.zones[zone].body_part_mult * rules.global.damage_scale;
    assert.ok(Math.abs(r.damage - want) < 1e-9, `${zone}: heavy damage ${r.damage} vs ${want}`);
  }
});

test("(3) no single light swing, counter-hit or not, at any real speed, kills or cuts a fresh head or torso", () => {
  let sawOverCut = false;
  for (const mk of [minotaur, man]) for (const zone of ["head", "torso"]) for (const handSpeed of SPEEDS) for (const counterHit of [false, true]) {
    const st = mk();
    const r = ev.evaluateHit(hit({ zone, handSpeed, swing: "light", counterHit }), st);
    sawOverCut ||= r.strength >= rules.strength_scale.rung_cut;
    assert.notEqual(r.outcome, "kill", `${mk.name} ${zone} ${handSpeed} counter=${counterHit}: ${JSON.stringify(r.events)}`);
    assert.equal(r.cut, null);
    assert.equal(st.alive, true);
    assert.ok(st.parts[zone].hp > 0 && !st.parts[zone].gone);
  }
  assert.ok(sawOverCut, "the sweep includes strengths over rung_cut (the original bug)");
});

test("(3b) a light counter-hit that is over the cut rung takes a modest slice of a fresh Minotaur torso (was ~78%)", () => {
  const st = minotaur();
  const r = ev.evaluateHit(hit({ zone: "torso", handSpeed: 9.74, swing: "light", counterHit: true }), st);
  assert.ok(r.strength >= rules.strength_scale.rung_cut);
  const slice = r.damage / st.parts.torso.max;
  assert.ok(slice > 0.05 && slice < 0.25, `slice ${slice.toFixed(3)}`);
});

test("(4) a light swing on a part whose remaining hp is at or under its damage kills; just above it, no cut", () => {
  for (const zone of ["head", "torso"]) for (const counterHit of [false, true]) {
    const probe = minotaur(); probe.parts[zone].hp = 1e6; probe.parts[zone].max = 1e6;
    const d = ev.evaluateHit(hit({ zone, handSpeed: 9.74, swing: "light", counterHit }), probe).damage;
    const lo = minotaur(); lo.parts[zone].hp = d * 0.999;
    assert.equal(ev.evaluateHit(hit({ zone, handSpeed: 9.74, swing: "light", counterHit }), lo).outcome, "kill", `${zone} counter=${counterHit}: hp just under the damage`);
    const eq = minotaur(); eq.parts[zone].hp = d;
    assert.equal(ev.evaluateHit(hit({ zone, handSpeed: 9.74, swing: "light", counterHit }), eq).outcome, "kill", `${zone}: hp equal to the damage`);
    const hi = minotaur(); hi.parts[zone].hp = d * 1.01;
    const r = ev.evaluateHit(hit({ zone, handSpeed: 9.74, swing: "light", counterHit }), hi);
    assert.notEqual(r.outcome, "kill", `${zone}: hp just over the damage survives`);
    assert.equal(r.cut, null, "and is not cut");
  }
});

test("(5) limbs are unchanged: a light damages a limb for strength x zone x global, and a light counter-hit still cuts one", () => {
  for (const zone of ["arm_off", "legs"]) {
    const st = minotaur();
    const part = zone === "legs" ? "leg_right" : "arm_" + (st.sword_side === "left" ? "right" : "left");
    const before = st.parts[part].hp;
    const r = ev.evaluateHit(hit({ zone, side: "right", handSpeed: 6.25, swing: "light" }), st);
    const want = r.strength * rules.zones[zone].body_part_mult * rules.global.damage_scale;
    assert.ok(Math.abs(r.damage - want) < 1e-9, `${zone} light damage ${r.damage} vs ${want}`);
    assert.ok(Math.abs(before - st.parts[part].hp - want) < 1e-9);
  }
  const c = ev.evaluateHit(hit({ zone: "arm_off", handSpeed: 9.74, swing: "light", counterHit: true }), minotaur());
  assert.equal(c.outcome, "cut");
});

test("the light multiplier is a row (0 < x <= 1); 1 = the old strength-only damage; a missing row throws", () => {
  const m = rules.evaluator.kill.light_damage_mult;
  assert.ok(m > 0 && m <= 1, `light_damage_mult ${m}`);
  const bare = JSON.parse(JSON.stringify(rules)); delete bare.evaluator.kill.light_damage_mult;
  assert.throws(() => createEvaluator(bare));
});

test("a consumer rules file that still carries the removed floor rows loads and the rows are ignored", () => {
  const legacy = JSON.parse(JSON.stringify(rules));
  legacy.evaluator.kill.light_floor_pct = 10; legacy.evaluator.kill.heavy_kill_floor_pct = 10;
  const e = createEvaluator(legacy);
  const st = createFighterState(legacy, undefined, { hp_scale: 190 / 150, budgets: { head: 40 } });
  let killed = false;
  for (let i = 0; i < 60 && !killed; i++) killed = e.evaluateHit(mixedLight("torso", i), st).outcome === "kill";
  assert.ok(killed, "no floor even if the row is present");
});
