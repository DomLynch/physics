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
  assert.equal(st.parts.torso.hp, 0);
  // every earlier light left the torso standing and uncut (the final blow, with hp <= its damage, may finish it as a cut)
  const st2 = minotaur();
  for (let i = 0; i < n - 1; i++) { const x = ev.evaluateHit(mixedLight("torso", i), st2); assert.equal(x.cut, null); assert.equal(st2.alive, true); }
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

test("(2) heavy swings (heavy p50 hand speed) kill a fresh Minotaur torso within 2 (damage alone: exactly 2) and a head in 1", () => {
  // heavy is unchanged: strength over rung_cut CUTS, so one heavy already kills by the cut. Damage alone (cut off) needs 2 on the torso.
  const dmg = ev.evaluateHit(hit({ zone: "torso", handSpeed: HEAVY_P50, swing: "heavy" }), minotaur()).damage;
  const max = minotaur().parts.torso.max;
  assert.ok(dmg < max && 2 * dmg >= max, `heavy damage ${dmg} of ${max}: 2 heavies by damage alone`);
  const st = minotaur();
  let n = 0, r;
  do { r = ev.evaluateHit(hit({ zone: "torso", handSpeed: HEAVY_P50, swing: "heavy" }), st); n++; } while (r.outcome !== "kill" && n < 5);
  assert.ok(r.outcome === "kill" && n <= 2, `heavies to kill a torso: ${n}`);
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
  // Strategy ruling on #54: a fresh part, man (head 20, torso 60) or Minotaur (head 40, torso 76), survives ANY one light, up to the fastest counter-hit
  for (const [mk, zone] of [[minotaur, "head"], [minotaur, "torso"], [man, "head"], [man, "torso"]]) for (const handSpeed of [...SPEEDS, 13, 16]) for (const counterHit of [false, true]) {
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
    const probe = minotaur(); probe.parts[zone].hp = 1e6; // max stays: the per-blow cap is part of "its damage"
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

// Strategy ruling on #54: evaluator.kill.light_part_cap_pct. A light's damage to a head or torso is capped at that percent of the part's FULL budget,
// per blow (not on total), so a fresh part always survives one light, man or boss; cumulative damage still kills.
test("light_part_cap_pct: one light never kills or cuts a fresh man head (20), Minotaur head (40) or either torso, even at 13 m/s counter-hit; N lights still kill", () => {
  const pct = rules.evaluator.kill.light_part_cap_pct;
  assert.ok(pct > 0 && pct < 100, `row light_part_cap_pct ${pct}`);
  for (const [mk, zone] of [[man, "head"], [minotaur, "head"], [man, "torso"], [minotaur, "torso"]]) {
    const st = mk();
    const max = st.parts[zone].max;
    const r = ev.evaluateHit(hit({ zone, handSpeed: 13, swing: "light", counterHit: true }), st);
    assert.notEqual(r.outcome, "kill", `${mk.name} ${zone}`);
    assert.equal(r.cut, null);
    assert.ok(r.damage <= max * pct / 100 + 1e-9, `${mk.name} ${zone}: ${r.damage} of ${max}`);
    assert.ok(st.parts[zone].hp >= max * (1 - pct / 100) - 1e-9);
    let n = 1;
    while (st.alive && n < 60) { ev.evaluateHit(hit({ zone, handSpeed: 13, swing: "light", counterHit: true }), st); n++; }
    assert.equal(st.alive, false, `${mk.name} ${zone}: cumulative lights still kill (${n})`);
    assert.ok(n >= 2, `${mk.name} ${zone}: at least 2 lights`);
  }
});

test("light_part_cap_pct: a light with remaining hp <= its capped damage still kills; heavy and limbs are not capped", () => {
  const st = man(); st.parts.head.hp = 1;
  assert.equal(ev.evaluateHit(hit({ zone: "head", handSpeed: 9.74, swing: "light" }), st).outcome, "kill");
  const h = ev.evaluateHit(hit({ zone: "head", handSpeed: 9.74, swing: "heavy" }), man());
  assert.equal(h.outcome, "kill");
  const want = h.strength * rules.zones.head.body_part_mult * rules.global.damage_scale;
  assert.ok(Math.abs(h.damage - want) < 1e-9, "heavy damage uncapped");
  const arm = ev.evaluateHit(hit({ zone: "arm_off", side: "right", handSpeed: 13, swing: "light", counterHit: true }), man());
  assert.equal(arm.outcome, "cut", "limb light counter-hit unchanged");
});
