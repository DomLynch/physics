// The seven-boss budget tool (tools/budget-seven.mjs, rows in data/budget-rows.json): the rows are well formed, every body they name exists, and a reduced run
// (2 counts, short, 1 set) gives finite timings, one cell per row combination, the cuts actually land and the world hash repeats. Timings are CPU physics-step cost only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { runBudget } from "../tools/budget-seven.mjs";

const rows = JSON.parse(readFileSync(new URL("../data/budget-rows.json", import.meta.url), "utf8"));

test("budget rows: schema, 1..7 counts, every named body exists, every scenario unit is real", () => {
  assert.equal(rows.schema, "budget-rows/1");
  assert.deepEqual(rows.counts, [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(rows.spacing_source && rows.budget_source);
  for (const s of rows.sets) {
    assert.equal(s.bodies.length, 7, s.id);
    for (const b of s.bodies) assert.ok(existsSync(new URL(`../data/bodies/${b}.measure.json`, import.meta.url)), `${s.id}: ${b}`);
  }
  const units = new Set(["head", "arm_left", "arm_right", "leg_left", "leg_right", "torso_waist"]);
  for (const sc of rows.scenarios) for (const c of sc.cuts) assert.ok(units.has(c.unit) && Number.isInteger(c.tick), `${sc.id}: ${c.unit}`);
  assert.ok(rows.sets.some((s) => s.bodies.some((b) => b.endsWith("-106"))) && rows.sets.some((s) => !s.bodies.some((b) => b.endsWith("-106"))), "both rigs covered");
});

test("reduced run: finite timings, cuts land, deterministic hash, more ragdolls never free", async () => {
  const res = await runBudget(rows, { counts: [1, 7], repeats: 2, ticks: 100, warm_ticks: 10, sets: ["boss106_mix"] });
  assert.equal(res.cells.length, 2 * rows.scenarios.length);
  for (const c of res.cells) {
    assert.ok(Number.isFinite(c.avg_ms) && c.avg_ms > 0 && c.p95_ms >= c.p50_ms && c.max_ms >= c.p95_ms, `${c.scenario} n=${c.n}`);
    assert.equal(c.deterministic, true, `${c.scenario} n=${c.n} hash repeats`);
  }
  const cell = (sc, n) => res.cells.find((c) => c.scenario === sc && c.n === n);
  assert.equal(cell("alive_idle", 7).cuts, 0);
  assert.equal(cell("alive_one_cut", 7).cuts, 1);
  assert.equal(cell("alive_all_cut", 7).cuts, 7);
  assert.equal(cell("dying_multi_cut", 7).cuts, 21);
});
