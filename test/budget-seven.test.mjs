// The seven-boss budget tool (tools/budget-seven.mjs, rows in data/budget-rows.json): the rows are well formed, every body they name exists, and a reduced run
// (2 counts, short, 1 set) gives finite timings, one cell per row combination, the cuts actually land and the world hash repeats. Timings are CPU physics-step cost only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { runBudget } from "../tools/budget-seven.mjs";
import { admit } from "../src/index.mjs";

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

// Cap on simultaneous ragdolls (Strategy ruling 2026-10-28: the 3 ms budget stays; bosses over the cap take the baked death). The row is
// data/budget-rows.json max_simultaneous_ragdolls; admit() is the pure helper the games call; the tool applies it with over.apply_cap.
test("cap row: integer 1..7 with a source note citing the seven-boss numbers", () => {
  const cap = rows.max_simultaneous_ragdolls;
  assert.ok(Number.isInteger(cap) && cap >= 1 && cap <= 7, "max_simultaneous_ragdolls is an integer 1..7");
  assert.ok(typeof rows.max_simultaneous_ragdolls_source === "string" && rows.max_simultaneous_ragdolls_source.includes("#64"), "source note cites #64");
});

test("admit(): the first `cap` bodies are ragdolls, every one after takes the baked death", () => {
  const cap = rows.max_simultaneous_ragdolls;
  for (let active = 0; active < cap; active++) assert.equal(admit(active, rows), "ragdoll", `active ${active}`);
  for (let active = cap; active <= 12; active++) assert.equal(admit(active, rows), "baked", `active ${active}`);
  assert.throws(() => admit(-1, rows));
  assert.throws(() => admit(0, {}), /max_simultaneous_ragdolls/);
});

test("admit(): rejects a bad activeCount (NaN, 1.5, Infinity, -Infinity, string, null, undefined) and a bad cap row (0, negative, 1.5, NaN, Infinity, string, missing)", () => {
  const ok = { max_simultaneous_ragdolls: 3 };
  for (const bad of [NaN, 1.5, Infinity, -Infinity, "1", null, undefined]) {
    assert.throws(() => admit(bad, ok), /activeCount/, `activeCount ${String(bad)}`);
  }
  for (const bad of [0, -1, -3, 1.5, NaN, Infinity, "3", null, undefined]) {
    assert.throws(() => admit(0, { max_simultaneous_ragdolls: bad }), /max_simultaneous_ragdolls/, `cap ${String(bad)}`);
  }
  assert.throws(() => admit(0, undefined), /max_simultaneous_ragdolls/);
  assert.throws(() => admit(0, null), /max_simultaneous_ragdolls/);
});

test("admit(): cap boundaries - cap 1 admits only the first body; a cap above 7 is accepted by admit() (the 1..7 limit lives in the row test, not the helper)", () => {
  assert.equal(admit(0, { max_simultaneous_ragdolls: 1 }), "ragdoll");
  assert.equal(admit(1, { max_simultaneous_ragdolls: 1 }), "baked");
  assert.equal(admit(7, { max_simultaneous_ragdolls: 8 }), "ragdoll");
  assert.equal(admit(8, { max_simultaneous_ragdolls: 8 }), "baked");
  assert.equal(admit(99, { max_simultaneous_ragdolls: 100 }), "ragdoll");
});

test("N=7 dying with cuts under the cap: only `cap` bosses are ragdolls and cut, the rest are baked, and the world is the N=cap world", async () => {
  const cap = rows.max_simultaneous_ragdolls;
  const small = { ticks: 100, warm_ticks: 10, repeats: 1, sets: ["boss106_mix"], scenarios: ["dying_multi_cut"] };
  const capped = (await runBudget(rows, { ...small, counts: [7], apply_cap: true })).cells[0];
  assert.equal(capped.n, 7);
  assert.equal(capped.ragdolls, cap);
  assert.equal(capped.baked, 7 - cap);
  assert.equal(capped.cuts, 3 * cap, "three cuts on each ragdoll, none on the baked");
  const uncapped = (await runBudget(rows, { ...small, counts: [7] })).cells[0];
  assert.equal(uncapped.ragdolls, 7);
  assert.equal(uncapped.baked, 0);
  assert.equal(uncapped.cuts, 21);
  const atCap = (await runBudget(rows, { ...small, counts: [cap] })).cells[0];
  assert.equal(capped.hash, atCap.hash, "the capped N=7 world is exactly the N=cap world");
  assert.equal(capped.deterministic, true);
});
