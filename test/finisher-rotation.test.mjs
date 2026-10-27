// Dom 2026-10-27: "I don't see any of the gore, the finishers; they should happen for almost every fight; rotate them."
// Strategy ruling: a finisher on every fight-ending kill by default (damage kills included), always on boss / last-enemy kills, pity <= 2,
// and a seeded no-repeat rotation through a data pool. Rows: evaluator.finisher.{base_pct, cap_pct, pity_after_kills, pool}.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEvaluator, createFighterState, rollFinisher, loadRules, mulberry32 } from "../src/index.mjs";

const rules = loadRules();
const F = rules.evaluator.finisher;
const ev = createEvaluator(rules);

test("rows: base 90 or more, pity at most 2, a pool of ids with where each applies", () => {
  assert.ok(F.base_pct >= 90, `base ${F.base_pct}`);
  assert.ok(F.pity_after_kills <= 2, `pity ${F.pity_after_kills}`);
  assert.ok(Array.isArray(F.pool) && F.pool.length >= 4);
  for (const id of ["decapitation", "split_crown", "belly_open", "waist_cut", "run_through"]) assert.ok(F.pool.some((p) => p.id === id), id);
});

test("kills by plain damage (zero overkill) get a finisher at least 88% of the time over 2000 kills, never 3 misses in a row", () => {
  const rand = mulberry32(7);
  let since = 0, fin = 0, run = 0, worst = 0, last = null;
  for (let i = 0; i < 2000; i++) {
    const r = rollFinisher(rules, { overkillPct: 0, killsSinceFinisher: since, part: i % 2 ? "head" : "torso", hitKind: "slash", lastKind: last }, rand);
    since = r.killsSinceFinisher;
    if (r.finisher) { fin++; run = 0; last = r.kind; } else { run++; worst = Math.max(worst, run); }
  }
  assert.ok(fin / 2000 >= 0.88, `finisher fraction ${fin / 2000}`);
  assert.ok(worst <= F.pity_after_kills, `longest miss streak ${worst}`);
});

test("boss and match-winning kills always fire; the finisher carries a kind from the pool that fits the part", () => {
  for (const flag of ["boss", "matchWinning"]) {
    for (let s = 0; s < 50; s++) {
      const r = rollFinisher(rules, { overkillPct: 0, [flag]: true, part: "head", hitKind: "slash" }, mulberry32(s));
      assert.equal(r.finisher, true);
      assert.ok(["decapitation", "split_crown"].includes(r.kind), r.kind);
    }
  }
  assert.equal(rollFinisher(rules, { overkillPct: 0, boss: true, part: "torso", hitKind: "stab" }, mulberry32(1)).finisher, true);
});

test("no back-to-back repeat: with another finisher available the rotation never repeats the last kind, and the same seed replays the same list", () => {
  const run = (seed) => {
    const rand = mulberry32(seed); const out = []; let last = null;
    for (let i = 0; i < 60; i++) {
      const part = i % 3 === 0 ? "torso" : "head";
      const r = rollFinisher(rules, { overkillPct: 0, boss: true, part, hitKind: "slash", lastKind: last }, rand);
      out.push(r.kind); last = r.kind;
    }
    return out;
  };
  const a = run(11);
  for (let i = 1; i < a.length; i++) assert.notEqual(a[i], a[i - 1], `repeat at ${i}: ${a[i]}`);
  assert.deepEqual(run(11), a, "replay-identical");
  assert.ok(new Set(a).size >= 3, "rotates through several kinds");
});

test("wired into a damage kill: no cut on the killing blow, finisher still rolled and a kind reported", () => {
  const st = createFighterState(rules, undefined, { hp_scale: 190 / 150, budgets: { head: 40 } });
  const rand = mulberry32(3); let t = 0, r, n = 0, since = 0, last = null;
  do {
    t += 100; n++;
    r = ev.evaluateHit({ weapon: "gm_katana", kind: "slash", zone: "torso", armour: "none", t, handSpeed: 7, swing: "light" }, st, { rand, finisher: { killsSinceFinisher: since, lastKind: last } });
  } while (r.outcome !== "kill" && n < 60);
  assert.equal(r.outcome, "kill");
  assert.equal(r.cut, null, "a plain damage kill");
  assert.ok(r.finisher && typeof r.finisher.chancePct === "number");
  if (r.finisher.finisher) assert.ok(["belly_open", "waist_cut"].includes(r.finisher.kind), r.finisher.kind);
});
