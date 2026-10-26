// V3's M4 asks: per-hit hand speed from the ragdoll, body budgets mapped to a game's health pools.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPhysics, createFighterState, loadRules } from "../src/index.mjs";

const body = JSON.parse(readFileSync(new URL("../data/bodies/minotaur.measure.json", import.meta.url), "utf8"));

test("hp_scale and budgets map the part budgets onto a game's own health pools", () => {
  const rules = loadRules();
  const base = createFighterState(rules, body), big = createFighterState(rules, body, { hp_scale: 5 }), custom = createFighterState(rules, body, { budgets: { head: 60, torso: 400 } });
  assert.equal(big.parts.head.hp, base.parts.head.hp * 5);
  assert.equal(big.parts.torso.max, base.parts.torso.max * 5);
  assert.equal(custom.parts.head.hp, 60);
  assert.equal(custom.parts.torso.hp, 400);
  assert.equal(custom.parts.arm_left.hp, base.parts.arm_left.hp, "unlisted parts keep their row");
  assert.throws(() => createFighterState(rules, body, { hp_scale: 0 }), /hp_scale/);
  assert.throws(() => createFighterState(rules, body, { budgets: { head: -1 } }), /budgets.head/);
});

test("partSpeed reads the hand's speed from the physics: zero at rest, large when the hand is swinging", async () => {
  const p = await createPhysics({ seed: 1 });
  const rd = p.createRagdoll(body);
  for (let t = 0; t < 30; t++) p.step(1 / 60);
  assert.ok(rd.partSpeed("handRight") < 0.2, "at rest");
  rd.applyImpulse("handRight", [0, 0, 5]);
  p.step(1 / 60);
  assert.ok(rd.partSpeed("handRight") > 1, "after a push");
  assert.ok(rd.partSpeed(["handLeft", "handRight"]) >= rd.partSpeed("handRight"));
  assert.throws(() => rd.partSpeed("tail"), /unknown part/);
  p.destroy();
});
