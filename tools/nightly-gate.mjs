// Pure parts of the nightly benchmark: medians, the budget/regression gate, the table and the results-file schema. No clock, no file, no network (tools/nightly.mjs times, scripts/nightly-post.mjs posts).
// A cell key is "<set>/<scenario>/n<N>/<cap|nocap>". A file is "nightly/1": { schema, sha, node, cpus, runs, cells: { key: { p95_ms } } } (+ target, date, skipped in a results file).
export const LIMIT_MS = 3;       // the physics budget (docs/BRIEF.md): OVER BUDGET above this
export const REGRESS_PCT = 20;   // REGRESSED when more than this percent above the previous night's stored value
export const SCHEMA = "nightly/1";

export const cellKey = ({ set, scenario, n, cap }) => `${set}/${scenario}/n${n}/${cap ? "cap" : "nocap"}`;

export function median(xs) {
  if (!xs.length) throw new Error("median of nothing");
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// runs: [{ key: p95_ms | null }]. One median per key over the runs that have a finite value; a key with no value anywhere is dropped.
export function medianCells(runs) {
  const by = {};
  for (const r of runs) for (const [k, v] of Object.entries(r)) if (Number.isFinite(v)) (by[k] ??= []).push(v);
  return Object.fromEntries(Object.entries(by).map(([k, v]) => [k, { p95_ms: median(v), runs: v.length }]));
}

// cells, baseline: { key: { p95_ms } } (baseline may be null/undefined: no regression is ever flagged without a stored value). skipped keys never fail.
export function gate(cells, baseline, { limit_ms = LIMIT_MS, regress_pct = REGRESS_PCT, skipped = [] } = {}) {
  const rows = [];
  for (const [key, c] of Object.entries(cells)) {
    const p = c.p95_ms, prev = baseline?.[key]?.p95_ms;
    const havePrev = Number.isFinite(prev) && prev > 0;
    const change_pct = havePrev ? ((p - prev) / prev) * 100 : null;
    const flags = [];
    if (p > limit_ms) flags.push("OVER BUDGET");
    if (havePrev && p > prev * (1 + regress_pct / 100)) flags.push("REGRESSED");
    rows.push({ key, p95_ms: p, prev_ms: havePrev ? prev : null, change_pct, status: flags.length ? flags.join(" + ") : "OK", flags });
  }
  for (const key of skipped) if (!(key in cells)) rows.push({ key, p95_ms: null, prev_ms: null, change_pct: null, status: "SKIPPED", flags: [] });
  return rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function flagLine(rows) {
  const bad = rows.filter((r) => r.flags.length);
  if (!bad.length) return "PASS";
  return `FLAG: ${bad.length} cell${bad.length === 1 ? "" : "s"}: ${bad.map((r) => `${r.key} (${r.status})`).join(", ")}`;
}

const ms = (v) => (v == null ? "-" : v.toFixed(3));
const chg = (v) => (v == null ? "-" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);
export function renderTable(rows) {
  return ["| cell | p95 ms | last night | change | status |", "|---|---:|---:|---:|---|",
    ...rows.map((r) => `| ${r.key} | ${ms(r.p95_ms)} | ${ms(r.prev_ms)} | ${chg(r.change_pct)} | ${r.status} |`)].join("\n");
}

// The issue body for one target: results is a nightly/1 results file, baseline a nightly/1 file or null. The first line is a marker so a poster can recognise its own body.
export function renderReport(results, baseline) {
  const lim = results.limit_ms ?? LIMIT_MS, pct = results.regress_pct ?? REGRESS_PCT;
  const rows = gate(results.cells, baseline?.cells, { limit_ms: lim, regress_pct: pct, skipped: results.skipped ?? [] });
  const short = (s) => "`" + String(s).slice(0, 12) + "`";
  const skipped = rows.filter((r) => r.status === "SKIPPED").map((r) => r.key);
  return [
    "<!-- nightly-physics-benchmark -->",
    `**${flagLine(rows)}**`,
    "",
    `${results.target ?? "target"} at ${short(results.sha)} | ${results.date ?? "no date"} | node ${results.node} | ${results.cpus} cpus | median p95 of ${results.runs} runs` +
      (baseline ? ` | compared with ${short(baseline.sha)}${baseline.date ? " of " + baseline.date : ""}` : " | no stored baseline yet, so the regression gate is off (the budget still applies)"),
    "",
    renderTable(rows),
    "",
    ...(skipped.length ? [`Skipped (tooling absent at this sha): ${skipped.join(", ")}`, ""] : []),
    `OVER BUDGET: p95 above ${lim} ms. REGRESSED: more than ${pct}% above the previous night's stored value. CPU cost of one 60 Hz physics tick on the Hugging Face CPU box, not a phone and not GPU.`,
  ].join("\n");
}

// returns the list of problems (empty = valid)
export function validateResults(o) {
  const e = [];
  if (!o || typeof o !== "object" || Array.isArray(o)) return ["not an object"];
  if (o.schema !== SCHEMA) e.push(`schema must be ${SCHEMA}`);
  if (typeof o.sha !== "string" || !/^[0-9a-f]{40}$/.test(o.sha)) e.push("sha must be a 40-hex commit");
  if (typeof o.node !== "string") e.push("node must be a string");
  if (!Number.isInteger(o.cpus) || o.cpus < 1) e.push("cpus must be a positive integer");
  if (!Number.isInteger(o.runs) || o.runs < 1) e.push("runs must be a positive integer");
  if (!o.cells || typeof o.cells !== "object" || Array.isArray(o.cells)) e.push("cells must be an object");
  else for (const [k, c] of Object.entries(o.cells)) {
    if (!/^[^/]+\/[^/]+\/n\d+\/(cap|nocap)$/.test(k)) e.push(`cell key '${k}' is not <set>/<scenario>/n<N>/<cap|nocap>`);
    if (!c || !Number.isFinite(c.p95_ms) || c.p95_ms < 0) e.push(`cell '${k}': p95_ms must be a finite number >= 0`);
  }
  if (o.skipped !== undefined && !(Array.isArray(o.skipped) && o.skipped.every((s) => typeof s === "string"))) e.push("skipped must be an array of cell keys");
  return e;
}
