// Per-body limb-loss rows (data/limb-loss.json, src/limb-loss.mjs): closed schema, loader, evaluator wiring, and that a body with no row is unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createEvaluator, createFighterState, loadRules, loadLimbLoss, validateLimbLoss } from "../src/index.mjs";
import { REGIONS } from "../tools/cut-units.mjs";

const rules = loadRules();
const ev = createEvaluator(rules);
const data = JSON.parse(readFileSync(new URL("../data/limb-loss.json", import.meta.url), "utf8"));
const W = "gm_gladius";
let clock = 0;
const hit = (o) => ({ weapon: W, kind: "slash", zone: "arm_sword", armour: "none", tipSpeed: 40, swing: "heavy", t: (clock += 100), ...o });
const PARTS = ["head", "torso", "arm_left", "arm_right", "leg_left", "leg_right"];

test("schema: file validates, is closed, and every row carries note + source", () => {
  assert.deepEqual(validateLimbLoss(data), []);
  assert.equal(data.schema, "limb-loss/1");
  for (const row of data.rows) assert.ok(row.note && row.source, row.body);
  const bad = (mut) => { const d = JSON.parse(JSON.stringify(data)); mut(d); return validateLimbLoss(d); };
  assert.ok(bad((d) => { d.extra = 1; }).length, "unknown top key");
  assert.ok(bad((d) => { d.rows[0].extra = 1; }).length, "unknown row key");
  assert.ok(bad((d) => { d.rows[0].leg_state = "crawl"; }).length, "leg_state enum");
  assert.ok(bad((d) => { d.rows[0].arm_gone_damage_mult = 1.5; }).length, "mult range");
  assert.ok(bad((d) => { d.rows[0].budgets = { tail: 5 }; }).length, "unknown part id");
  assert.ok(bad((d) => { d.rows[0].budgets = { head: 0 }; }).length, "budget above 0");
  assert.ok(bad((d) => { d.rows[1].piece_hostile = { arm_right: { attack: "swipe" } }; }).length, "hostile needs hp");
  assert.ok(bad((d) => { d.rows[1].piece_hostile = { tail: { attack: "swipe", hp: 1 } }; }).length, "hostile unit must be a cut unit");
  assert.ok(bad((d) => { d.rows.push({ ...d.rows[0] }); }).length, "duplicate body");
});

test("loader: unknown body returns null; a returned row is a copy", () => {
  assert.equal(loadLimbLoss("no-such-body"), null);
  assert.equal(loadLimbLoss(undefined), null);
  const a = loadLimbLoss("castle-guard"); a.leg_state = "x";
  assert.equal(loadLimbLoss("castle-guard").leg_state, "kneel");
});

test("castle-guard: sword-arm loss yields the row's multiplier on the weapon_drop event and the state", () => {
  const row = loadLimbLoss("castle-guard");
  assert.ok(row.arm_gone_damage_mult > rules.locational.arm_gone_damage_mult && row.arm_gone_damage_mult < 1);
  const s = createFighterState(ev.rules, PARTS, { limbLoss: row });
  for (const id of PARTS) if (row.budgets[id]) assert.equal(s.parts[id].max, row.budgets[id]);
  const r = ev.evaluateHit(hit({ zone: "arm_sword" }), s);
  assert.equal(r.cut?.unit, "arm_right");
  const drop = r.events.find((e) => e.type === "weapon_drop");
  assert.equal(drop.outgoing_damage_mult, row.arm_gone_damage_mult);
  assert.equal(s.outgoing_damage_mult, row.arm_gone_damage_mult);
});

test("castle-guard: one leg gone gives leg_state kneel on leg_gone; off arm only emits off_arm_gone", () => {
  const row = loadLimbLoss("castle-guard");
  const s = createFighterState(ev.rules, PARTS, { limbLoss: row });
  const r = ev.evaluateHit(hit({ zone: "legs", side: "left" }), s);
  const g = r.events.find((e) => e.type === "leg_gone");
  assert.equal(g.leg_state, "kneel");
  assert.equal(g.crawl_to_stand_s, rules.locational.leg_crawl_to_stand_s);
  assert.equal(s.limp, true);
  assert.equal(s.leg_state, "kneel");
  const s2 = createFighterState(ev.rules, PARTS, { limbLoss: row });
  const r2 = ev.evaluateHit(hit({ zone: "arm_off" }), s2);
  assert.ok(r2.events.some((e) => e.type === "off_arm_gone"));
  assert.equal(s2.outgoing_damage_mult, 1);
});

test("no-row body is unchanged: same events, same state shape, global multiplier, no leg_state", () => {
  const s = createFighterState(ev.rules, PARTS);
  for (const k of ["arm_gone_damage_mult", "leg_state", "piece_hostile"]) assert.equal(k in s, false, k);
  const r = ev.evaluateHit(hit({ zone: "arm_sword" }), s);
  assert.deepEqual(r.events.find((e) => e.type === "weapon_drop"), { type: "weapon_drop", arm: "arm_right", outgoing_damage_mult: rules.locational.arm_gone_damage_mult });
  assert.equal("piece_hostile" in r.events.find((e) => e.type === "cut"), false);
  const l = ev.evaluateHit(hit({ zone: "legs", side: "left" }), s);
  assert.deepEqual(l.events.find((e) => e.type === "leg_gone"), { type: "leg_gone", leg: "leg_left", crawl_to_stand_s: rules.locational.leg_crawl_to_stand_s });
  // an explicit null limbLoss is the same as none
  assert.equal(JSON.stringify(createFighterState(ev.rules, PARTS, { limbLoss: null })), JSON.stringify(createFighterState(ev.rules, PARTS)));
});

test("pumpkinhulk: piece_hostile published by the loader, units exist in the cut unit list, and the cut event carries it", () => {
  const row = loadLimbLoss("pumpkinhulk");
  const cutUnits = new Set(REGIONS.map((r) => r.detached_by).filter(Boolean));
  for (const u of ["arm_right", "arm_left"]) {
    assert.ok(cutUnits.has(u), u);
    assert.equal(row.piece_hostile[u].attack, "swipe");
    assert.equal(row.piece_hostile[u].hp, 10);
  }
  for (const u of Object.keys(row.piece_hostile)) assert.ok(cutUnits.has(u), `piece_hostile.${u} is not a cut unit`);
  const s = createFighterState(ev.rules, PARTS, { limbLoss: row });
  assert.deepEqual(s.piece_hostile, row.piece_hostile);
  const r = ev.evaluateHit(hit({ zone: "arm_sword" }), s);
  assert.deepEqual(r.events.find((e) => e.type === "cut").piece_hostile, { attack: "swipe", hp: 10 });
});
