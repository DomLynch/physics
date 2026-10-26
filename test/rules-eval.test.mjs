// Rules evaluator: every outcome reachable from the rows, armour never blocks, two counters, determinism.
// Table-driven: speeds are derived from the rows, so a measurement PR that changes numbers needs no test edits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createEvaluator, createFighterState, rollFinisher, loadRules, rulesHash, mulberry32 } from "../src/index.mjs";

const rules = loadRules();
const clone = () => JSON.parse(JSON.stringify(rules));
const S = rules.strength_scale;
const GATE = rules.melee_speed_gate;
const W = "gm_gladius";
const sharp = (kind, weapon = W) => (kind === "slash" ? rules.weapons[weapon].slash_mult : kind === "stab" ? rules.weapons[weapon].stab_mult : rules.evaluator.kinds.blunt.sharpness);
// tip speed that gives exactly `strength` (clamped above the full-strength end of the speed gate)
const tipFor = (strength, kind = "slash", weapon = W) => Math.max(strength / sharp(kind, weapon), GATE.min_speed_m_s + GATE.full_strength_margin_m_s);
const fresh = (r = rules, opts) => createFighterState(r, undefined, opts);
let clock = 0;
const hit = (o) => ({ weapon: W, kind: "slash", zone: "torso", armour: "none", t: (clock += 100), ...o });

test("each outcome is reachable from a table of hits", () => {
  const ev = createEvaluator(rules);
  const table = [
    ["miss (below the melee speed gate)", { tipSpeed: GATE.min_speed_m_s - 1, zone: "legs", side: "left" }, "miss"],
    ["miss (below the hit rung)", { tipSpeed: tipFor(S.rung_hit - 1), zone: "legs", side: "left" }, "miss"],
    ["hit", { tipSpeed: tipFor(S.rung_hit + 1), zone: "legs", side: "left" }, "hit"],
    ["stick", { tipSpeed: tipFor(S.rung_stick + 1, "stab"), kind: "stab", zone: "arm_off" }, "stick"],
    ["cut", { tipSpeed: tipFor(S.rung_cut * 1.05), zone: "arm_off" }, "cut"],
    ["knockdown (push force)", { tipSpeed: tipFor(S.rung_hit + 1), zone: "legs", side: "right", force: rules.knockdown.push_force_over + 1 }, "knockdown"],
    ["kill (head budget)", { tipSpeed: tipFor(S.rung_hit + 1), zone: "head" }, "kill"],
  ];
  for (const [name, h, want] of table) {
    const r = ev.evaluateHit(hit(h), fresh());
    assert.equal(r.outcome, want, `${name}: ${JSON.stringify(r.events)}`);
  }
});

test("strength is tip speed x sharpness; damage adds zone x global x armour column; rungs read from the rows", () => {
  const ev = createEvaluator(rules);
  const tip = 10;
  const r = ev.evaluateHit(hit({ tipSpeed: tip, zone: "torso", armour: "mail", kind: "stab" }), fresh());
  assert.ok(Math.abs(r.strength - tip * rules.weapons[W].stab_mult) < 1e-9);
  const want = r.strength * rules.zones.torso.body_part_mult * rules.global.damage_scale * rules.armour_tiers.mail.damage_taken_mult.stab;
  assert.ok(Math.abs(r.damage - want) < 1e-9);
  assert.equal(r.partHpAfter, rules.part_hp.torso - r.damage);
  // moving the rung row moves the outcome, no code change
  const hot = clone(); hot.strength_scale.rung_hit = r.strength + 1;
  assert.equal(createEvaluator(hot).evaluateHit(hit({ tipSpeed: tip, zone: "torso", kind: "stab" }), fresh(hot)).outcome, "miss");
});

test("armour raises the cut threshold but never blocks: every weapon cuts through every tier", () => {
  const ev = createEvaluator(rules);
  for (const [tierId, tier] of Object.entries(rules.armour_tiers)) {
    const threshold = S.rung_cut * tier.dismember_threshold_modifier;
    const below = ev.evaluateHit(hit({ tipSpeed: tipFor(threshold * 0.98), zone: "arm_off", armour: tierId }), fresh());
    assert.notEqual(below.outcome, "cut", `${tierId}: just under the threshold does not cut`);
    assert.ok(Math.abs(below.cutThreshold - threshold) < 1e-9);
    for (const [wid, w] of Object.entries(rules.weapons)) {
      if (w.slash_mult === null || w.slash_bone_mult === null) continue; // todo rows: see the fail-loud test
      const r = ev.evaluateHit(hit({ weapon: wid, tipSpeed: tipFor(threshold * 1.02, "slash", wid), zone: "arm_off", armour: tierId }), fresh());
      assert.equal(r.outcome, "cut", `${wid} through ${tierId}`);
      assert.equal(r.cut.unit, "arm_left");
    }
  }
  // per-zone tiers: plate on the head only, bare arm still cuts at the base rung
  const r = ev.evaluateHit(hit({ tipSpeed: tipFor(S.rung_cut * 1.02), zone: "arm_off", armour: { head: "plate_t3" } }), fresh());
  assert.equal(r.outcome, "cut");
  assert.throws(() => ev.evaluateHit(hit({ tipSpeed: 20, armour: "unobtainium" }), fresh()), /unknown armour tier/);
});

test("bone gate sits before the cut and armour multiplies it (rows drive it)", () => {
  const strict = clone(); strict.bone_gate.numerator_m_s = 1000; // no tip speed in the test reaches it
  const r = createEvaluator(strict).evaluateHit(hit({ tipSpeed: tipFor(S.rung_cut * 1.5), zone: "arm_off" }), fresh(strict));
  assert.notEqual(r.outcome, "cut");
  assert.ok(r.events.some((e) => e.type === "bone_gate_not_met"));
  const tip = 40;
  const ev = createEvaluator(rules);
  const bare = ev.evaluateHit(hit({ tipSpeed: tip, zone: "arm_off", armour: "none" }), fresh());
  const plate = ev.evaluateHit(hit({ tipSpeed: tip, zone: "arm_off", armour: "plate_t3" }), fresh());
  assert.ok(Math.abs(plate.boneGateSpeed / bare.boneGateSpeed - rules.armour_tiers.plate_t3.dismember_threshold_modifier) < 1e-9);
  // the bone column agrees with the formula on the rows we ship
  for (const w of Object.values(rules.weapons)) {
    for (const k of ["slash", "stab"]) {
      if (w[k + "_bone_mult"] === null) continue;
      assert.ok(Math.abs(rules.bone_gate.numerator_m_s / Math.sqrt(w[k + "_bone_mult"]) - w["bone_break_speed_" + k]) < 0.02, "bone_break_speed_" + k);
    }
  }
});

test("a stab over the cut rung sticks and bleeds but never severs; blunt forces the fall instead of cutting", () => {
  const ev = createEvaluator(rules);
  const st = fresh();
  const s = ev.evaluateHit(hit({ kind: "stab", tipSpeed: tipFor(S.rung_cut * 1.2, "stab"), zone: "arm_off" }), st);
  assert.equal(s.outcome, "stick"); assert.equal(s.cut, null); assert.equal(s.bleed, true);
  const b = ev.evaluateHit(hit({ kind: "blunt", tipSpeed: S.rung_cut * 2, zone: "arm_off" }), fresh());
  assert.notEqual(b.outcome, "cut");
});

test("knockdown counter: separate from budgets, falls at the row, resets on fall, getup grace ignores the next", () => {
  const ev = createEvaluator(rules);
  const st = fresh();
  st.knockdown.counter = rules.knockdown.counter_fall_at - 1;
  const t0 = 1000;
  const r1 = ev.evaluateHit({ ...hit({ tipSpeed: tipFor(S.rung_hit + 1), zone: "legs", side: "left" }), t: t0 }, st);
  assert.equal(r1.outcome, "knockdown");
  assert.equal(r1.knockdown.fallSeconds, rules.knockdown.fall_seconds.damage);
  assert.equal(st.knockdown.counter, 0, "counter resets on fall");
  assert.ok(st.parts.leg_left.hp < st.parts.leg_left.max, "budget kept its own damage");
  // second knockdown inside the grace window is ignored (damage still lands, counter does not move)
  st.knockdown.counter = rules.knockdown.counter_fall_at - 1;
  const inGrace = t0 + rules.knockdown.getup_grace_s / 2;
  const r2 = ev.evaluateHit({ ...hit({ tipSpeed: tipFor(S.rung_hit + 1), zone: "legs", side: "right", force: rules.knockdown.push_force_over + 1 }), t: inGrace }, st);
  assert.equal(r2.knockdown, null);
  assert.ok(r2.events.some((e) => e.type === "knockdown_ignored"));
  assert.equal(st.knockdown.counter, rules.knockdown.counter_fall_at - 1);
  // grace spans fall + downed + getup grace
  const free = t0 + rules.knockdown.fall_seconds.damage + rules.knockdown.fall_seconds.down + rules.knockdown.getup_grace_s + 0.01;
  const r3 = ev.evaluateHit({ ...hit({ tipSpeed: tipFor(S.rung_hit + 1), zone: "torso", force: rules.knockdown.push_force_over + 1 }), t: free }, st);
  assert.equal(r3.outcome, "knockdown");
  assert.equal(r3.knockdown.cause, "push");
  assert.ok(Math.abs(r3.knockdown.fallSeconds - rules.knockdown.fall_seconds.push * rules.knockdown.stun_duration_pct[1] / 100) < 1e-9, "second stun is diminished");
});

test("diminishing stun steps follow the row, then drop out, then reset after the window", () => {
  const ev = createEvaluator(rules);
  const st = fresh();
  const pcts = rules.knockdown.stun_duration_pct;
  let t = 5000;
  const seen = [];
  for (let i = 0; i < pcts.length; i++) {
    st.parts.torso.hp = st.parts.torso.max; // keep it alive: this test is about the stun, not the budget
    const r = ev.evaluateHit({ ...hit({ tipSpeed: tipFor(S.rung_hit + 1), zone: "torso", force: rules.knockdown.push_force_over + 1 }), t }, st);
    seen.push(r.knockdown ? r.knockdown.stunPct : 0);
    t += rules.knockdown.fall_seconds.push + rules.knockdown.fall_seconds.down + rules.knockdown.getup_grace_s + 0.1;
  }
  assert.deepEqual(seen, pcts);
  st.parts.torso.hp = st.parts.torso.max;
  const again = ev.evaluateHit({ ...hit({ tipSpeed: tipFor(S.rung_hit + 1), zone: "torso", force: rules.knockdown.push_force_over + 1 }), t: t + rules.evaluator.stun_window_s + 1 }, st);
  assert.equal(again.knockdown.stunPct, pcts[0]);
});

test("kill rules: head budget empty, torso budget empty, both legs gone (one leg limps)", () => {
  const ev = createEvaluator(rules);
  // head
  let st = fresh();
  let r = ev.evaluateHit(hit({ kind: "stab", tipSpeed: tipFor(S.rung_hit + 1, "stab"), zone: "head" }), st);
  assert.equal(r.outcome, "kill"); assert.equal(st.alive, false); assert.equal(st.cause_of_death, "head");
  // torso: stab hard until the budget goes
  st = fresh();
  for (let i = 0; i < 10 && st.alive; i++) r = ev.evaluateHit(hit({ kind: "stab", tipSpeed: tipFor(S.rung_stick * 1.2, "stab"), zone: "torso" }), st);
  assert.equal(st.alive, false); assert.equal(st.parts.torso.hp, 0); assert.equal(r.outcome, "kill");
  // legs
  st = fresh();
  const legHit = (side) => ev.evaluateHit(hit({ kind: "stab", tipSpeed: tipFor(S.rung_stick * 1.5, "stab"), zone: "legs", side }), st);
  while (!st.parts.leg_left.gone) legHit("left");
  assert.equal(st.alive, true); assert.equal(st.limp, true);
  assert.ok(st.parts.leg_left.max >= rules.part_hp.legs_min && st.parts.leg_left.max <= rules.part_hp.legs_max);
  while (!st.parts.leg_right.gone) r = legHit("right");
  assert.equal(st.alive, false); assert.equal(r.outcome, "kill");
  assert.equal(st.cause_of_death, "leg_left+leg_right");
  // a cut through the head is a kill that names its unit
  st = fresh();
  r = ev.evaluateHit(hit({ tipSpeed: tipFor(S.rung_cut * 1.1), zone: "head" }), st);
  assert.equal(r.outcome, "kill"); assert.equal(r.cut.unit, "head");
});

test("locational: sword arm gone drops the weapon and weakens outgoing damage; the attacker state scales damage", () => {
  const ev = createEvaluator(rules);
  const st = fresh();
  const r = ev.evaluateHit(hit({ tipSpeed: tipFor(S.rung_cut * 1.1), zone: "arm_sword" }), st);
  assert.equal(r.cut.unit, "arm_right");
  assert.equal(st.weapon_dropped, true);
  assert.equal(st.outgoing_damage_mult, rules.locational.arm_gone_damage_mult);
  assert.ok(r.events.some((e) => e.type === "weapon_drop"));
  const victim = () => fresh();
  const a = ev.evaluateHit(hit({ tipSpeed: 10, zone: "torso" }), victim());
  const b = ev.evaluateHit(hit({ tipSpeed: 10, zone: "torso", attacker: st }), victim());
  assert.ok(Math.abs(b.damage - a.damage * rules.locational.arm_gone_damage_mult) < 1e-9);
  const left = createEvaluator(rules).evaluateHit(hit({ tipSpeed: tipFor(S.rung_cut * 1.1), zone: "arm_sword" }), fresh(rules, { sword_side: "left" }));
  assert.equal(left.cut.unit, "arm_left");
});

test("bleed: a cut starts one timer (rows), the target dies when it runs out; a corpse is cut by any capable hit", () => {
  const ev = createEvaluator(rules);
  const st = fresh();
  const t0 = 10;
  const r = ev.evaluateHit({ ...hit({ tipSpeed: tipFor(S.rung_cut * 1.1), zone: "arm_off" }), t: t0 }, st);
  assert.equal(r.bleed, true);
  assert.ok(st.bleed.seconds >= rules.bleed_out.seconds_min && st.bleed.seconds <= rules.bleed_out.seconds_max);
  const late = ev.evaluateHit({ ...hit({ tipSpeed: tipFor(S.rung_hit + 1), zone: "torso" }), t: t0 + rules.bleed_out.seconds_max + 1 }, st);
  assert.equal(st.alive, false); assert.equal(st.cause_of_death, "bleed_out");
  assert.ok(late.events.some((e) => e.type === "bleed_out"));
  // dead body: cut a leg off, no damage, no budget movement elsewhere
  const c = ev.evaluateHit({ ...hit({ tipSpeed: tipFor(S.rung_cut * 1.1), zone: "legs", side: "left" }), t: t0 + 100 }, st);
  assert.equal(c.outcome, "cut"); assert.equal(c.cut.unit, "leg_left"); assert.equal(c.damage, 0);
  // and a second cut on the same gone part cuts nothing
  const d = ev.evaluateHit({ ...hit({ tipSpeed: tipFor(S.rung_cut * 1.1), zone: "legs", side: "left" }), t: t0 + 101 }, st);
  assert.equal(d.cut, null);
});

test("finisher roll: caller rand, base + overkill capped, sure on match win, boss and pity", () => {
  const f = rules.evaluator.finisher;
  const lo = rollFinisher(rules, { overkillPct: 0 }, () => 0.9999);
  assert.equal(lo.finisher, false); assert.equal(lo.chancePct, f.base_pct); assert.equal(lo.killsSinceFinisher, 1);
  assert.equal(rollFinisher(rules, { overkillPct: 10 }, () => 0).chancePct, f.base_pct + 10 * f.per_overkill_pct);
  assert.equal(rollFinisher(rules, { overkillPct: 1e6 }, () => 0).chancePct, f.cap_pct);
  assert.equal(rollFinisher(rules, { overkillPct: 0, matchWinning: true }, () => 0.99).finisher, true);
  assert.equal(rollFinisher(rules, { overkillPct: 0, boss: true }, () => 0.99).finisher, true);
  assert.equal(rollFinisher(rules, { overkillPct: 0, killsSinceFinisher: f.pity_after_kills }, () => 0.99).finisher, true);
  // wired into a kill
  const ev = createEvaluator(rules);
  const r = ev.evaluateHit(hit({ tipSpeed: tipFor(S.rung_cut * 1.1), zone: "head" }), fresh(), { rand: () => 0, finisher: {} });
  assert.equal(r.outcome, "kill"); assert.equal(r.finisher.finisher, true);
  assert.equal(ev.evaluateHit(hit({ tipSpeed: tipFor(S.rung_hit + 1), zone: "head" }), fresh()).finisher, null, "no rand, no roll");
});

test("fails loudly on a missing or null row", () => {
  const ev = createEvaluator(rules);
  assert.throws(() => ev.evaluateHit(hit({ weapon: "tabg_viking_axe", tipSpeed: 20 }), fresh()), /slash_mult/);
  assert.throws(() => ev.evaluateHit(hit({ weapon: "nope", tipSpeed: 20 }), fresh()), /unknown weapon/);
  assert.throws(() => ev.evaluateHit(hit({ zone: "legs", tipSpeed: 20 }), fresh()), /side/);
  assert.throws(() => ev.evaluateHit({ weapon: W, kind: "slash", zone: "torso", tipSpeed: 20 }, fresh()), /hit\.t/);
  const broken = clone(); delete broken.evaluator;
  assert.throws(() => createEvaluator(broken), /evaluator/);
  assert.throws(() => createFighterState(rules, 5), /measure row/);
});

test("createFighterState: budgets from the rows, from part ids or a body measure row", () => {
  const body = JSON.parse(readFileSync(new URL("../data/bodies/minotaur.measure.json", import.meta.url), "utf8"));
  const st = createFighterState(rules, body);
  assert.deepEqual(Object.keys(st.parts).sort(), ["arm_left", "arm_right", "head", "leg_left", "leg_right", "torso"]);
  assert.equal(st.parts.head.hp, rules.part_hp.head);
  assert.equal(st.parts.torso.hp, rules.part_hp.torso);
  assert.equal(st.parts.arm_right.hp, rules.part_hp.arm_sword);
  assert.equal(st.parts.arm_left.hp, rules.part_hp.arm_off);
  assert.equal(createFighterState(rules, undefined, { sword_side: "left" }).parts.arm_left.hp, rules.part_hp.arm_sword);
  assert.equal(createFighterState(rules, undefined, { leg_hp: 9999 }).parts.leg_left.hp, rules.part_hp.legs_max);
  assert.deepEqual(JSON.parse(JSON.stringify(st)), st, "state is plain JSON");
});

test("deterministic: the same hit sequence twice gives identical results and state hash", () => {
  const run = () => {
    const ev = createEvaluator(rules);
    const rand = mulberry32(7);
    const st = fresh();
    const seq = [
      { tipSpeed: 9, zone: "legs", side: "left" }, { tipSpeed: 14, kind: "stab", zone: "torso" },
      { tipSpeed: 40, zone: "arm_off" }, { tipSpeed: 12, zone: "legs", side: "right", force: 90 },
      { tipSpeed: 30, kind: "stab", zone: "torso", armour: "mail" }, { tipSpeed: 25, zone: "head", armour: "plate_t3" },
      { tipSpeed: 60, zone: "head" },
    ];
    const out = seq.map((h, i) => ev.evaluateHit({ weapon: W, kind: "slash", armour: "none", ...h, t: i * 0.7 }, st, { rand }));
    return rulesHash({ out: out.map(({ state, ...r }) => r), st });
  };
  assert.equal(run(), run());
});

test("the evaluator source has no random, clock or timer calls", () => {
  const src = readFileSync(new URL("../src/rules-eval.mjs", import.meta.url), "utf8");
  for (const bad of ["Math." + "random", "Date" + ".now", "new " + "Date", "performance" + ".now", "node:"]) assert.ok(!src.includes(bad), bad);
});
