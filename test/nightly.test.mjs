// Nightly benchmark: the pure gate (tools/nightly-gate.mjs), the table, the results-file schema, the rows file, and a reduced run of tools/nightly.mjs. Timing lives in the tool, never in src/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { median, cellKey, medianCells, gate, flagLine, renderTable, validateResults, LIMIT_MS, REGRESS_PCT } from "../tools/nightly-gate.mjs";
import { runNightly } from "../tools/nightly.mjs";

test("defaults: 3 ms limit, 20% regression", () => { assert.equal(LIMIT_MS, 3); assert.equal(REGRESS_PCT, 20); });

test("cell key: set/scenario/nN/cap", () => {
  assert.equal(cellKey({ set: "boss106_warrok_x7", scenario: "dying_all_cut", n: 7, cap: true }), "boss106_warrok_x7/dying_all_cut/n7/cap");
  assert.equal(cellKey({ set: "a", scenario: "b", n: 3, cap: false }), "a/b/n3/nocap");
});

test("median: odd, even, unsorted, one value, empty throws", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([7]), 7);
  assert.throws(() => median([]));
});

test("median of 5 absorbs one noisy run", () => {
  const runs = [2.1, 2.0, 9.5, 2.2, 2.05].map((v) => ({ "a/b/n1/cap": v }));
  const c = medianCells(runs);
  assert.equal(c["a/b/n1/cap"].p95_ms, 2.1);
  assert.equal(c["a/b/n1/cap"].runs, 5);
});

test("medianCells: a cell missing from some runs uses the runs that have it; absent everywhere is dropped", () => {
  const c = medianCells([{ x: 1, y: 5 }, { x: 3 }, { x: 2, y: null }]);
  assert.equal(c.x.p95_ms, 2);
  assert.equal(c.y.p95_ms, 5);
  assert.equal(c.y.runs, 1);
  assert.equal(medianCells([{ z: null }, {}]).z, undefined);
});

const base = { "a/n/n1/cap": { p95_ms: 2.0 }, "b/n/n1/cap": { p95_ms: 2.0 }, "c/n/n1/cap": { p95_ms: 2.0 }, "d/n/n1/cap": { p95_ms: 2.0 } };

test("gate: OK, OVER BUDGET above 3 ms (exactly 3 is OK), REGRESSED above +20% (exactly +20% is OK)", () => {
  const cur = { "a/n/n1/cap": { p95_ms: 2.3 }, "b/n/n1/cap": { p95_ms: 3.0 }, "c/n/n1/cap": { p95_ms: 3.01 }, "d/n/n1/cap": { p95_ms: 2.41 } };
  const rows = gate(cur, base);
  const st = Object.fromEntries(rows.map((r) => [r.key, r.status]));
  assert.equal(st["a/n/n1/cap"], "OK");
  assert.equal(st["b/n/n1/cap"], "REGRESSED"); // 3.0 vs 2.0 is +50%, within the 3 ms limit
  assert.equal(st["c/n/n1/cap"], "OVER BUDGET + REGRESSED");
  assert.equal(st["d/n/n1/cap"], "REGRESSED");
  assert.equal(gate({ x: { p95_ms: 2.4 } }, { x: { p95_ms: 2.0 } })[0].status, "OK");
  assert.equal(gate({ x: { p95_ms: 3.0 } }, { x: { p95_ms: 3.0 } })[0].status, "OK");
  assert.ok(Math.abs(rows.find((r) => r.key === "d/n/n1/cap").change_pct - 20.5) < 1e-9);
});

test("gate: over budget alone, regression alone, improvement is OK", () => {
  assert.equal(gate({ x: { p95_ms: 3.5 } }, { x: { p95_ms: 3.4 } })[0].status, "OVER BUDGET");
  assert.equal(gate({ x: { p95_ms: 1.5 } }, { x: { p95_ms: 1.0 } })[0].status, "REGRESSED");
  const r = gate({ x: { p95_ms: 1.0 } }, { x: { p95_ms: 2.0 } })[0];
  assert.equal(r.status, "OK");
  assert.equal(r.change_pct, -50);
});

test("gate: missing baseline (null, undefined, empty, or a new cell) is never a regression", () => {
  for (const b of [null, undefined, {}]) {
    const r = gate({ x: { p95_ms: 2.9 } }, b)[0];
    assert.equal(r.status, "OK");
    assert.equal(r.prev_ms, null);
    assert.equal(r.change_pct, null);
  }
  assert.equal(gate({ x: { p95_ms: 2.9 }, y: { p95_ms: 1 } }, { y: { p95_ms: 1 } })[0].status, "OK");
  assert.equal(gate({ x: { p95_ms: 3.2 } }, null)[0].status, "OVER BUDGET", "the budget still applies without a baseline");
  assert.equal(gate({ x: { p95_ms: 5 } }, { x: { p95_ms: 0 } })[0].change_pct, null, "a zero baseline gives no percentage");
});

test("gate: skipped cells are listed, never fail, and a skipped cell with a baseline does not regress", () => {
  const rows = gate({ a: { p95_ms: 1 } }, { a: { p95_ms: 1 }, s: { p95_ms: 1 } }, { skipped: ["s", "t"] });
  assert.deepEqual(rows.map((r) => [r.key, r.status]), [["a", "OK"], ["s", "SKIPPED"], ["t", "SKIPPED"]]);
  assert.equal(flagLine(rows), "PASS");
});

test("gate: custom limit and percentage, rows sorted by key", () => {
  const rows = gate({ b: { p95_ms: 1.6 }, a: { p95_ms: 1.0 } }, { b: { p95_ms: 1.0 }, a: { p95_ms: 1.0 } }, { limit_ms: 1.5, regress_pct: 50 });
  assert.deepEqual(rows.map((r) => r.key), ["a", "b"]);
  assert.equal(rows[1].status, "OVER BUDGET + REGRESSED");
});

test("flagLine: PASS, or FLAG naming every failing cell", () => {
  assert.equal(flagLine(gate({ a: { p95_ms: 1 } }, null)), "PASS");
  const l = flagLine(gate({ a: { p95_ms: 4 }, b: { p95_ms: 1.5 }, c: { p95_ms: 1 } }, { b: { p95_ms: 1 }, c: { p95_ms: 1 } }));
  assert.equal(l, "FLAG: 2 cells: a (OVER BUDGET), b (REGRESSED)");
  assert.equal(flagLine(gate({ a: { p95_ms: 4 } }, null)), "FLAG: 1 cell: a (OVER BUDGET)");
});

test("renderTable: golden string", () => {
  const rows = gate({ "a/dying_all_cut/n3/cap": { p95_ms: 2.5 }, "b/dying_all_cut/n7/cap": { p95_ms: 3.456 }, "c/idle/n1/nocap": { p95_ms: 0.8 } },
    { "a/dying_all_cut/n3/cap": { p95_ms: 2.0 }, "b/dying_all_cut/n7/cap": { p95_ms: 3.4 } }, { skipped: ["d/parked/n30/nocap"] });
  const want = [
    "| cell | p95 ms | last night | change | status |",
    "|---|---:|---:|---:|---|",
    "| a/dying_all_cut/n3/cap | 2.500 | 2.000 | +25.0% | REGRESSED |",
    "| b/dying_all_cut/n7/cap | 3.456 | 3.400 | +1.6% | OVER BUDGET |",
    "| c/idle/n1/nocap | 0.800 | - | - | OK |",
    "| d/parked/n30/nocap | - | - | - | SKIPPED |",
  ].join("\n");
  assert.equal(renderTable(rows), want);
});

const good = () => ({ schema: "nightly/1", target: "physics-main", sha: "a".repeat(40), node: "v22.1.0", cpus: 8, runs: 5, date: "2026-10-28", cells: { "a/b/n1/cap": { p95_ms: 1.2 } }, skipped: ["c/d/n1/cap"] });

test("results schema: a good file passes; each defect is named", () => {
  assert.deepEqual(validateResults(good()), []);
  const bad = (f) => { const o = good(); f(o); return validateResults(o); };
  assert.ok(bad((o) => { o.schema = "nightly/2"; }).some((e) => /schema/.test(e)));
  assert.ok(bad((o) => { o.sha = "xyz"; }).some((e) => /sha/.test(e)));
  assert.ok(bad((o) => { o.runs = 0; }).some((e) => /runs/.test(e)));
  assert.ok(bad((o) => { o.cpus = "8"; }).some((e) => /cpus/.test(e)));
  assert.ok(bad((o) => { o.node = 22; }).some((e) => /node/.test(e)));
  assert.ok(bad((o) => { o.cells = []; }).some((e) => /cells/.test(e)));
  assert.ok(bad((o) => { o.cells["a/b/n1/cap"].p95_ms = NaN; }).some((e) => /p95_ms/.test(e)));
  assert.ok(bad((o) => { o.cells["a/b/n1/cap"].p95_ms = -1; }).some((e) => /p95_ms/.test(e)));
  assert.ok(bad((o) => { o.cells["badkey"] = { p95_ms: 1 }; }).some((e) => /key/.test(e)));
  assert.ok(bad((o) => { o.skipped = "x"; }).some((e) => /skipped/.test(e)));
  assert.ok(validateResults(null).length > 0);
});

test("a baseline (no target, date or skipped) is still a valid nightly/1 file", () => {
  const b = good(); delete b.target; delete b.date; delete b.skipped;
  assert.deepEqual(validateResults(b), []);
});

const nr = JSON.parse(readFileSync(new URL("../data/nightly-rows.json", import.meta.url), "utf8"));
const br = JSON.parse(readFileSync(new URL("../data/budget-rows.json", import.meta.url), "utf8"));

test("data/nightly-rows.json: schema, cells well formed, sets and scenarios exist in budget-rows", () => {
  assert.equal(nr.schema, "nightly-rows/1");
  assert.equal(nr.runs, 5);
  assert.equal(nr.limit_ms, 3);
  assert.equal(nr.regress_pct, 20);
  const keys = new Set();
  for (const c of nr.cells) {
    const key = cellKey(c);
    assert.ok(!keys.has(key), "duplicate " + key);
    keys.add(key);
    if (c.kind === "parked") { assert.ok(c.needs, key); continue; }
    const set = br.sets.find((s) => s.id === c.set);
    assert.ok(set, key);
    assert.ok(br.scenarios.some((s) => s.id === c.scenario), key);
    assert.ok(c.n >= 1 && c.n <= set.bodies.length, key);
  }
  for (const k of ["boss106_warrok_x7/dying_all_cut/n7/cap", "boss106_mix/dying_all_cut/n3/cap"]) assert.ok(keys.has(k), k);
});

test("runNightly (reduced): valid nightly/1 file, medians of the runs, a cell whose tool is absent is skipped, not failed", async () => {
  const small = { ...nr, runs: 3, cells: [
    { set: "boss106_mix", scenario: "dying_all_cut", n: 3, cap: true },
    { set: "no_such_set", scenario: "dying_all_cut", n: 3, cap: true },
    { kind: "parked", set: "parked", scenario: "idle", n: 30, cap: false, needs: "tools/does-not-exist.mjs" },
  ] };
  const res = await runNightly(small, br, { ticks: 60, warm_ticks: 10, target: "test", sha: "b".repeat(40), date: "2026-10-28" });
  assert.deepEqual(validateResults(res), []);
  assert.equal(res.runs, 3);
  const c = res.cells["boss106_mix/dying_all_cut/n3/cap"];
  assert.ok(c && Number.isFinite(c.p95_ms) && c.p95_ms > 0 && c.runs === 3);
  assert.deepEqual(res.skipped.sort(), ["no_such_set/dying_all_cut/n3/cap", "parked/idle/n30/nocap"]);
  assert.equal(flagLine(gate(res.cells, null, { skipped: res.skipped, limit_ms: 1000 })), "PASS");
});
