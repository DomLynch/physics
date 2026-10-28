// The crowd budget rows (data/budget-crowd.json, run by tools/budget-seven.mjs unchanged): plain MakeHuman humanoids, no cuts, N = 3..10, alive_idle and dying_uncut.
// Measurement only: the rows are well formed, every body they name exists, a reduced run gives finite deterministic timings with no cuts, and the cap row in
// data/budget-rows.json is NOT touched by the crowd work (a cap change is a proposal in the PR body, ruled by Strategy).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { runBudget } from "../tools/budget-seven.mjs";

const json = (f) => JSON.parse(readFileSync(new URL(f, import.meta.url), "utf8"));
let crowd = { sets: [], scenarios: [], counts: [] };
try { crowd = json("../data/budget-crowd.json"); } catch { /* red until the data file lands: each test then fails on its own */ }

test("crowd rows: same schema and constants as the seven-boss rows, counts 3..10, 3 ms budget, spacing and source stated", () => {
  const seven = json("../data/budget-rows.json");
  assert.equal(crowd.schema, "budget-rows/1");
  assert.deepEqual(crowd.counts, [3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(crowd.budget_ms, 3);
  for (const k of ["ticks", "warm_ticks", "repeats", "motor_strength"]) assert.deepEqual(crowd[k], seven[k], `${k} is the seven-boss convention`);
  assert.ok(crowd.spacing_m > 0 && crowd.spacing_source && crowd.budget_source && crowd.about);
});

test("crowd rows: one humanoid set of ten MakeHuman measure rows that exist, scenarios alive_idle and dying_uncut only, no cuts anywhere", () => {
  assert.equal(crowd.sets.length, 1);
  const s = crowd.sets[0];
  assert.equal(s.bodies.length, 10);
  assert.notEqual(s.kind, "chain", "humanoid measure rows, not chain bodies");
  for (const b of s.bodies) assert.ok(existsSync(new URL(`../data/bodies/${b}.measure.json`, import.meta.url)), b);
  assert.deepEqual(crowd.scenarios.map((x) => x.id), ["alive_idle", "dying_uncut"]);
  for (const sc of crowd.scenarios) assert.deepEqual(sc.cuts, [], `${sc.id}: no cuts`);
  assert.equal(crowd.scenarios[0].kill, undefined);
  assert.equal(crowd.scenarios[1].kill.tick, 70);
});

test("the crowd work proposes a cap, it does not set one: max_simultaneous_ragdolls in budget-rows.json is unchanged and the crowd file carries none", () => {
  assert.equal(json("../data/budget-rows.json").max_simultaneous_ragdolls, 3);
  assert.ok(!("max_simultaneous_ragdolls" in crowd));
});

test("reduced crowd run: N = 3 and 10, every ragdoll simulated, finite timings, no cuts, deterministic hash", async () => {
  const res = await runBudget(crowd, { counts: [3, 10], repeats: 2, ticks: 100, warm_ticks: 10 });
  assert.equal(res.cells.length, 2 * crowd.scenarios.length);
  for (const c of res.cells) {
    assert.equal(c.ragdolls, c.n, `${c.scenario} n=${c.n}: none baked`);
    assert.equal(c.cuts, 0);
    assert.ok(Number.isFinite(c.avg_ms) && c.avg_ms > 0 && c.p95_ms >= c.p50_ms && c.max_ms >= c.p95_ms, `${c.scenario} n=${c.n}`);
    assert.equal(c.deterministic, true, `${c.scenario} n=${c.n} hash repeats`);
  }
});
