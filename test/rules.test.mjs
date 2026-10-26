// M4/M6 rule rows: data/rules.json validates, bad probes are rejected, JSON round-trip is identical.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateRules, rulesHash, loadRules } from "../src/rules.mjs";
import { lintNoBlock } from "../src/generate.mjs";

const raw = readFileSync(new URL("../data/rules.json", import.meta.url), "utf8");
const fresh = () => JSON.parse(raw);

test("data/rules.json validates", () => {
  const r = validateRules(fresh());
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.ok(loadRules().weapons.gm_katana);
});

test("required columns exist", () => {
  const r = fresh();
  for (const k of ["slash_mult", "stab_mult", "bone_break_speed"]) assert.ok(k in r.weapons.gm_katana, k);
  assert.equal(typeof r.zones.head.body_part_mult, "number");
  assert.equal(typeof r.knockdown.fall_seconds.damage, "number");
  assert.equal(typeof r.knockdown.recover_per_s, "number");
  for (const s of ["idle", "attack", "roll", "fall", "dead"]) assert.ok(s in r.stiffness_by_state, s);
});

const probes = {
  "immune field": (r) => { r.knockdown.stun_immune = true; },
  "invulnerability field": (r) => { r.knockdown.getup_invulnerability_s = 1.5; },
  "block field on armour": (r) => { r.armour_tiers.plate_t3.block = true; },
  "cannot_sever field": (r) => { r.armour_tiers.mail.cannot_sever = true; },
  "no_dismember field": (r) => { r.weapons.gm_dagger.no_dismember = true; },
  "prevent field": (r) => { r.zones.head.prevent_cut = true; },
  "unknown key": (r) => { r.zones.head.extra = 1; },
  "unknown top-level key": (r) => { r.mystery = {}; },
  "missing required key": (r) => { delete r.knockdown.recover_per_s; },
  "missing required column": (r) => { delete r.weapons.gm_katana.bone_break_speed; },
  "negative multiplier": (r) => { r.zones.legs.body_part_mult = -0.5; },
  "negative weapon multiplier": (r) => { r.weapons.gm_katana.slash_mult = -1; },
  "armour modifier below 1": (r) => { r.armour_tiers.plate_t3.dismember_threshold_modifier = 0.9; },
  "wrong type": (r) => { r.global.damage_scale = "0.65"; },
  "missing source": (r) => { delete r.zones.head.source; },
  "null without todo": (r) => { delete r.weapons.tabg_shovel.todo; },
};
for (const [name, mutate] of Object.entries(probes)) {
  test(`rejects: ${name}`, () => {
    const r = fresh();
    mutate(r);
    const res = validateRules(r);
    assert.equal(res.ok, false, name + " should be rejected");
    assert.ok(res.errors.length > 0);
  });
}

test("lintNoBlock rejects the key words anywhere, nested and in arrays", () => {
  for (const k of ["immune", "invulnerable", "block", "cannot_sever", "no_dismember", "prevent"]) {
    assert.ok(lintNoBlock({ a: { b: [{ [k]: 1 }] } }, "rules").length > 0, k);
  }
  assert.deepEqual(lintNoBlock(fresh(), "rules"), []);
});

test("round-trip: stringify, parse, validate gives an identical object and hash", () => {
  const a = fresh();
  const b = JSON.parse(JSON.stringify(a));
  assert.equal(validateRules(b).ok, true);
  assert.deepEqual(b, a);
  assert.equal(rulesHash(b), rulesHash(a));
  assert.match(rulesHash(a), /^[0-9a-f]{64}$/);
  // key order does not change the hash; a value change does
  const shuffled = Object.fromEntries(Object.entries(a).reverse());
  assert.equal(rulesHash(shuffled), rulesHash(a));
  const c = fresh(); c.global.damage_scale = 0.66;
  assert.notEqual(rulesHash(c), rulesHash(a));
});
